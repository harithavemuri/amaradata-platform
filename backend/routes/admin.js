const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { version: APP_VERSION } = require('../../package.json');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');
// Not destructured — same mockability reasoning as tenants.js's client requires.
const ownerPortalTenantClient = require('../services/owner-portal-tenant-client');

const VALID_ROLES = ['super_admin', 'admin', 'sales_manager', 'billing', 'staff', 'property_owner'];

// All admin routes require super_admin
router.use(requireSuperAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users  — enriched with group memberships
router.get('/users', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const rows    = req.db.fileDb.find('amr_users');
            const members = req.db.fileDb.find('amr_group_members');
            const groups  = req.db.fileDb.find('amr_groups');
            const enriched = rows.map(u => {
                const userGroups = members
                    .filter(m => m.user_id == u.id)
                    .map(m => {
                        const g = groups.find(g => g.id == m.group_id);
                        return g ? { id: g.id, name: g.name } : null;
                    })
                    .filter(Boolean);
                return { ..._safeUser(u), groups: userGroups };
            });
            return res.json({ success: true, data: enriched });
        }
        let rows;
        try {
            ({ rows } = await db.query(`
                SELECT u.id, u.username, u.email, u.name, u.first_name, u.last_name,
                       u.role, u.google_id, u.logo_url, u.owner_portal_uid,
                       u.is_active, u.last_login_at, u.created_at, u.updated_at,
                       COALESCE(json_agg(json_build_object('id',g.id,'name',g.name))
                         FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
                FROM amr_users u
                LEFT JOIN amr_group_members m ON m.user_id = u.id
                LEFT JOIN amr_groups g ON g.id = m.group_id
                GROUP BY u.id ORDER BY u.created_at DESC
            `));
        } catch {
            ({ rows } = await db.query(`
                SELECT id, username, email, name, first_name, last_name, role,
                       google_id, logo_url, owner_portal_uid,
                       is_active, last_login_at, created_at, updated_at,
                       '[]'::json AS groups
                FROM amr_users ORDER BY created_at DESC
            `));
        }
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin] users:'); }
});

// POST /api/admin/users
router.post('/users', blockNonDbWrite, async (req, res) => {
    const { email, name, first_name, last_name, role = 'staff', password } = req.body;
    const username = req.body.username || email;
    if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    try {
        const password_hash = password ? await bcrypt.hash(password, 12) : '';
        const fn = first_name || name.split(' ')[0];
        const ln = last_name  || name.split(' ').slice(1).join(' ') || null;
        // property_owner accounts get their cross-tenant identity generated
        // immediately, never entered by hand — see project-owner-portal.md.
        const ownerPortalUid = role === 'property_owner' ? crypto.randomUUID() : null;

        const { rows } = await db.query(
            `INSERT INTO amr_users (username,email,name,first_name,last_name,role,password_hash,owner_portal_uid)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id,username,email,name,first_name,last_name,role,is_active,created_at,owner_portal_uid`,
            [username, email, name, fn, ln, role, password_hash, ownerPortalUid]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
        sendError(res, e, '[admin] create-user:');
    }
});

// PUT /api/admin/users/:id
router.put('/users/:id', blockNonDbWrite, async (req, res) => {
    const { name, first_name, last_name, role, is_active, password } = req.body;
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    try {
        const updates = {};
        if (name        !== undefined) updates.name        = name;
        if (first_name  !== undefined) updates.first_name  = first_name;
        if (last_name   !== undefined) updates.last_name   = last_name;
        if (role        !== undefined) updates.role        = role;
        if (is_active   !== undefined) updates.is_active   = is_active;
        if (password)                  updates.password_hash = await bcrypt.hash(password, 12);

        // Switching a user TO property_owner must give them a cross-tenant
        // identity if they don't already have one — never editable by hand.
        if (role === 'property_owner') {
            const { rows: [existing] } = await db.query('SELECT owner_portal_uid FROM amr_users WHERE id = $1', [req.params.id]);
            if (existing && !existing.owner_portal_uid) updates.owner_portal_uid = crypto.randomUUID();
        }

        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE amr_users SET ${sets} WHERE id = $${keys.length + 1}
             RETURNING id,email,name,first_name,last_name,role,is_active,updated_at,owner_portal_uid`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// DELETE /api/admin/users/:id  (soft-delete — sets is_active=false)
router.delete('/users/:id', blockNonDbWrite, async (req, res) => {
    try {
        const { rowCount } = await db.query(
            'UPDATE amr_users SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// ── User Groups ───────────────────────────────────────────────────────────────

// GET /api/admin/user-groups — enriched with members and tenant assignments
router.get('/user-groups', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const groups      = req.db.fileDb.find('amr_groups');
            const members     = req.db.fileDb.find('amr_group_members');
            const users       = req.db.fileDb.find('amr_users');
            const groupTenant = req.db.fileDb.find('group_tenant');
            const roles       = req.db.fileDb.find('amr_roles');
            const tenants     = req.db.fileDb.find('tenants');
            const enriched = groups.map(g => {
                const tenant_assignments = groupTenant
                    .filter(gt => gt.group_id == g.id)
                    .map(gt => {
                        const t = tenants.find(t => t.id == gt.tenant_id);
                        const r = roles.find(r => r.id == gt.role_id);
                        return { id: gt.id, tenant_id: gt.tenant_id, tenant_name: t?.name || null, role_id: gt.role_id, role: r?.name || null, role_label: r?.label || null };
                    });
                return {
                    ...g,
                    member_count: members.filter(m => m.group_id == g.id).length,
                    members: members
                        .filter(m => m.group_id == g.id)
                        .map(m => {
                            const u = users.find(u => u.id == m.user_id);
                            return u ? { id: u.id, name: u.name, email: u.email, role: u.role, is_active: u.is_active } : null;
                        })
                        .filter(Boolean),
                    tenant_assignments,
                };
            });
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT g.*,
                   (SELECT COUNT(*)::int FROM amr_group_members m WHERE m.group_id = g.id) AS member_count,
                   COALESCE((
                     SELECT json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'is_active',u.is_active)
                       ORDER BY u.name)
                     FROM amr_group_members m
                     JOIN amr_users u ON u.id = m.user_id
                     WHERE m.group_id = g.id
                   ), '[]') AS members,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'id', gt.id, 'tenant_id', t.id, 'tenant_name', t.name,
                       'role_id', r.id, 'role', r.name, 'role_label', r.label
                     ) ORDER BY t.name)
                     FROM group_tenant gt
                     JOIN tenants t    ON t.id = gt.tenant_id
                     JOIN amr_roles r  ON r.id = gt.role_id
                     WHERE gt.group_id = g.id
                   ), '[]') AS tenant_assignments
            FROM amr_groups g
            ORDER BY g.created_at, g.name
        `);
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// POST /api/admin/user-groups
router.post('/user-groups', blockNonDbWrite, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        const { rows } = await db.query(
            'INSERT INTO amr_groups (name,description) VALUES ($1,$2) RETURNING *',
            [name, description || '']
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Group name already exists' });
        sendError(res, e, '[admin]');
    }
});

// PUT /api/admin/user-groups/:id
router.put('/user-groups/:id', blockNonDbWrite, async (req, res) => {
    const { name, description, is_active } = req.body;
    try {
        const updates = {};
        if (name        !== undefined) updates.name        = name;
        if (description !== undefined) updates.description = description;
        if (is_active   !== undefined) updates.is_active   = is_active;

        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE amr_groups SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Group name already exists' });
        sendError(res, e, '[admin]');
    }
});

// DELETE /api/admin/user-groups/:id
router.delete('/user-groups/:id', blockNonDbWrite, async (req, res) => {
    try {
        const { rowCount } = await db.query('DELETE FROM amr_groups WHERE id = $1', [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Group not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// POST /api/admin/user-groups/:id/members  { user_id }
router.post('/user-groups/:id/members', blockNonDbWrite, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO amr_group_members (group_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (group_id, user_id) DO NOTHING RETURNING *`,
            [req.params.id, user_id]
        );
        if (!rows[0]) return res.status(409).json({ error: 'Already a member' });
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// DELETE /api/admin/user-groups/:id/members/:userId
router.delete('/user-groups/:id/members/:userId', blockNonDbWrite, async (req, res) => {
    try {
        const { rowCount } = await db.query(
            'DELETE FROM amr_group_members WHERE group_id = $1 AND user_id = $2',
            [req.params.id, req.params.userId]
        );
        if (!rowCount) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// ── Group → Tenant assignments (group_tenant) ─────────────────────────────────

// POST /api/admin/user-groups/:id/tenants  { tenant_id, role_id }
router.post('/user-groups/:id/tenants', blockNonDbWrite, async (req, res) => {
    const { tenant_id, role_id } = req.body;
    if (!tenant_id || !role_id) return res.status(400).json({ error: 'tenant_id and role_id are required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO group_tenant (group_id, tenant_id, role_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (group_id, tenant_id, role_id) DO NOTHING RETURNING *`,
            [req.params.id, tenant_id, role_id]
        );
        if (!rows[0]) return res.status(409).json({ error: 'Assignment already exists' });
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// DELETE /api/admin/user-groups/:id/tenants/:gtId
router.delete('/user-groups/:id/tenants/:gtId', blockNonDbWrite, async (req, res) => {
    try {
        const { rowCount } = await db.query(
            'DELETE FROM group_tenant WHERE id = $1 AND group_id = $2',
            [req.params.gtId, req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────

// GET /api/admin/roles  — enriched with direct users and groups that have this role via group_tenant
router.get('/roles', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const roles       = req.db.fileDb.find('amr_roles');
            const users       = req.db.fileDb.find('amr_users');
            const groups      = req.db.fileDb.find('amr_groups');
            const members     = req.db.fileDb.find('amr_group_members');
            const groupTenant = req.db.fileDb.find('group_tenant');
            const enriched = roles.map(r => ({
                ...r,
                user_count: users.filter(u => u.role === r.name).length,
                users: users.filter(u => u.role === r.name)
                            .map(u => ({ id: u.id, name: u.name, email: u.email, is_active: u.is_active })),
                groups: groupTenant
                    .filter(gt => gt.role_id == r.id)
                    .map(gt => {
                        const g = groups.find(g => g.id == gt.group_id);
                        return g ? { id: g.id, name: g.name, member_count: members.filter(m => m.group_id == g.id).length } : null;
                    })
                    .filter(Boolean),
            }));
            return res.json({ success: true, data: enriched });
        }
        let rows;
        try {
            ({ rows } = await db.query(`
                SELECT r.*,
                       (SELECT COUNT(*)::int FROM amr_users u WHERE u.role = r.name) AS user_count,
                       COALESCE((
                         SELECT json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email,'is_active',u.is_active)
                           ORDER BY u.name)
                         FROM amr_users u WHERE u.role = r.name
                       ), '[]') AS users,
                       COALESCE((
                         SELECT json_agg(json_build_object('id',g.id,'name',g.name,'member_count',
                           (SELECT COUNT(*)::int FROM amr_group_members m WHERE m.group_id = g.id))
                           ORDER BY g.name)
                         FROM group_tenant gt
                         JOIN amr_groups g ON g.id = gt.group_id
                         WHERE gt.role_id = r.id
                       ), '[]') AS groups
                FROM amr_roles r
                ORDER BY r.created_at ASC
            `));
        } catch {
            ({ rows } = await db.query(`
                SELECT id, name, label, description, is_system, created_at, updated_at,
                       0 AS user_count, '[]'::json AS users, '[]'::json AS groups
                FROM amr_roles ORDER BY created_at ASC
            `));
        }
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin] roles:'); }
});

// POST /api/admin/roles
router.post('/roles', blockNonDbWrite, async (req, res) => {
    const { name, label, description } = req.body;
    if (!name || !label) return res.status(400).json({ error: 'name and label are required' });
    if (!/^[a-z_]+$/.test(name)) return res.status(400).json({ error: 'name must be lowercase letters and underscores only' });
    try {
        const { rows } = await db.query(
            'INSERT INTO amr_roles (name,label,description,is_system) VALUES ($1,$2,$3,false) RETURNING *',
            [name, label, description || '']
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Role name already exists' });
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/admin/roles/:id
router.put('/roles/:id', blockNonDbWrite, async (req, res) => {
    const { label, description } = req.body;
    try {
        const { rows } = await db.query(
            `UPDATE amr_roles SET label = COALESCE($1, label), description = COALESCE($2, description),
             updated_at = NOW() WHERE id = $3 RETURNING *`,
            [label || null, description !== undefined ? description : null, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Role not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// DELETE /api/admin/roles/:id  (system roles cannot be deleted)
router.delete('/roles/:id', blockNonDbWrite, async (req, res) => {
    try {
        const { rows: [role] } = await db.query('SELECT * FROM amr_roles WHERE id = $1', [req.params.id]);
        if (!role) return res.status(404).json({ error: 'Role not found' });
        if (role.is_system) return res.status(403).json({ error: 'System roles cannot be deleted' });
        const { rows: [{ cnt }] } = await db.query(
            'SELECT COUNT(*)::int AS cnt FROM amr_users WHERE role = $1', [role.name]
        );
        if (cnt > 0) return res.status(409).json({ error: `${cnt} user(s) have this role. Reassign them first.` });
        await db.query('DELETE FROM amr_roles WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin]'); }
});

// ── Owner Portal Links ───────────────────────────────────────────────────────
// Maps a property_owner account (amr_users) to one specific row in one
// tenant's own property_owners table — see owner_tenant_links in
// database/schema.sql and project-owner-portal.md. Pure AmaraData-side
// bookkeeping/display: the portal itself never reads this table at request
// time, and which tenants an owner can query at all is governed entirely by
// group_tenant (role=property_owner), independent of whether a link row
// exists here. The actual cross-tenant push uses owner-portal-tenant-client.js
// (that tenant's own dedicated API key), not the SSO staff-impersonation flow
// tenant-sso-client.js uses for /api/admin/* proxying.

// GET /api/admin/users/:id/owner-links
router.get('/users/:id/owner-links', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const tenants = req.db.fileDb.find('tenants');
            const links = req.db.fileDb.find('owner_tenant_links')
                .filter(l => l.owner_user_id == req.params.id)
                .map(l => ({ ...l, tenant_name: tenants.find(t => t.id == l.tenant_id)?.name || null }));
            return res.json({ success: true, data: links });
        }
        const { rows } = await db.query(
            `SELECT l.*, t.name AS tenant_name
             FROM owner_tenant_links l
             JOIN tenants t ON t.id = l.tenant_id
             WHERE l.owner_user_id = $1
             ORDER BY t.name`,
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin/owner-links]'); }
});

// POST /api/admin/users/:id/owner-links
// { tenant_id, tenant_project_id, tenant_owner_id, tenant_owner_email, tenant_owner_name }
// tenant_owner_email/name are whatever GET /api/tenants/:tenantId/owner-candidates
// already returned to the frontend for this row — denormalized for display
// only (see the table comment in schema.sql), never re-synced from the tenant.
router.post('/users/:id/owner-links', blockNonDbWrite, async (req, res) => {
    const { tenant_id, tenant_project_id, tenant_owner_id, tenant_owner_email, tenant_owner_name } = req.body;
    if (!tenant_id || !tenant_project_id || !tenant_owner_id) {
        return res.status(400).json({ error: 'tenant_id, tenant_project_id, and tenant_owner_id are required' });
    }
    try {
        const { rows: [owner] } = await db.query('SELECT * FROM amr_users WHERE id = $1', [req.params.id]);
        if (!owner) return res.status(404).json({ error: 'Owner not found' });
        if (owner.role !== 'property_owner') return res.status(400).json({ error: 'User is not a property_owner' });

        // Auto-generate on first link too, in case this account predates the
        // create/role-change auto-generation added alongside this table.
        let ownerPortalUid = owner.owner_portal_uid;
        if (!ownerPortalUid) {
            ownerPortalUid = crypto.randomUUID();
            await db.query('UPDATE amr_users SET owner_portal_uid = $1, updated_at = NOW() WHERE id = $2', [ownerPortalUid, req.params.id]);
        }

        const { rows: [tenant] } = await db.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        await ownerPortalTenantClient.linkOwner(tenant, {
            project_id: tenant_project_id, owner_id: tenant_owner_id, identifier: ownerPortalUid,
        });

        const { rows } = await db.query(
            `INSERT INTO owner_tenant_links (owner_user_id, tenant_id, tenant_project_id, tenant_owner_id, tenant_owner_email, tenant_owner_name)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (owner_user_id, tenant_id, tenant_project_id, tenant_owner_id)
             DO UPDATE SET tenant_owner_email = EXCLUDED.tenant_owner_email, tenant_owner_name = EXCLUDED.tenant_owner_name, updated_at = NOW()
             RETURNING *`,
            [req.params.id, tenant_id, tenant_project_id, tenant_owner_id, tenant_owner_email || null, tenant_owner_name || null]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.tenantUnreachable) return res.status(502).json({ error: `Tenant site unavailable: ${e.message}` });
        if (e.tenantStatus) return res.status(e.tenantStatus).json({ error: e.message });
        sendError(res, e, '[admin/owner-links]');
    }
});

// DELETE /api/admin/users/:id/owner-links/:linkId — removes the AmaraData-side
// record only. Does NOT clear the tenant's own
// property_owners.owner_portal_identifier — real tenant access is governed
// by group_tenant, not this table, so an orphaned identifier on the tenant
// side is harmless bookkeeping drift, not a live access grant.
router.delete('/users/:id/owner-links/:linkId', blockNonDbWrite, async (req, res) => {
    try {
        const { rowCount } = await db.query(
            'DELETE FROM owner_tenant_links WHERE id = $1 AND owner_user_id = $2',
            [req.params.linkId, req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Link not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[admin/owner-links]'); }
});

// POST /api/admin/users/:id/rotate-owner-uid — generates a fresh
// owner_portal_uid and re-pushes it to every tenant this owner is currently
// linked to. Per-tenant propagation failures are reported back individually
// rather than failing the whole rotation — one unreachable tenant must not
// block rotating the account's identity; the caller can retry that tenant's
// link afterward. Refuses to rotate a disabled account — an inactive owner
// has no live session that would need a new value pushed out.
router.post('/users/:id/rotate-owner-uid', blockNonDbWrite, async (req, res) => {
    try {
        const { rows: [owner] } = await db.query('SELECT * FROM amr_users WHERE id = $1', [req.params.id]);
        if (!owner) return res.status(404).json({ error: 'Owner not found' });
        if (owner.role !== 'property_owner') return res.status(400).json({ error: 'User is not a property_owner' });
        if (!owner.is_active) return res.status(400).json({ error: 'Cannot rotate the identity of a disabled owner account' });

        const { rows: links } = await db.query(
            `SELECT l.id AS link_id, l.tenant_project_id, l.tenant_owner_id,
                    t.id AS tenant_id, t.name AS tenant_name, t.site_url,
                    t.owner_portal_api_key, t.owner_portal_api_key_secret_arn
             FROM owner_tenant_links l JOIN tenants t ON t.id = l.tenant_id
             WHERE l.owner_user_id = $1`,
            [req.params.id]
        );

        const newUid = crypto.randomUUID();
        const results = [];
        for (const link of links) {
            try {
                await ownerPortalTenantClient.linkOwner(link, {
                    project_id: link.tenant_project_id, owner_id: link.tenant_owner_id, identifier: newUid,
                });
                results.push({ tenant_id: link.tenant_id, tenant_name: link.tenant_name, success: true });
            } catch (e) {
                results.push({ tenant_id: link.tenant_id, tenant_name: link.tenant_name, success: false, error: e.message });
            }
        }

        await db.query('UPDATE amr_users SET owner_portal_uid = $1, updated_at = NOW() WHERE id = $2', [newUid, req.params.id]);
        res.json({ success: true, data: { owner_portal_uid: newUid, tenants: results } });
    } catch (e) { sendError(res, e, '[admin/rotate-owner-uid]'); }
});

// ── Login Audit ───────────────────────────────────────────────────────────────

// GET /api/admin/login-audit — most recent login events, enriched with user info
router.get('/login-audit', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const users = req.db.fileDb.find('amr_users');
            const rows = req.db.fileDb.find('login_audit')
                .slice()
                .sort((a, b) => new Date(b.logged_in_at) - new Date(a.logged_in_at))
                .slice(0, 500)
                .map(a => {
                    const u = users.find(u => u.id == a.user_id);
                    return { ...a, username: u?.username || null, name: u?.name || null, email: u?.email || null };
                });
            return res.json({ success: true, data: rows });
        }
        const { rows } = await db.query(`
            SELECT la.*, u.username, u.name, u.email
            FROM login_audit la
            JOIN amr_users u ON u.id = la.user_id
            ORDER BY la.logged_in_at DESC
            LIMIT 500
        `);
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin/login-audit]'); }
});

// ── Billing Metrics Collection ───────────────────────────────────────────────
// Manual trigger + history for jobs/collect-metrics.js — see
// project-billing-metrics-collector.md. Runs synchronously (one HTTP call
// per tenant, one INSERT), which is safely inside API Gateway's Lambda-proxy
// timeout for today's single-tenant scale; if the tenant count grows large
// enough for that to matter, this needs to move to an async job with polling
// (same tradeoff already noted on /sync-from-db/:table above).

// POST /api/admin/billing/collect-metrics  { period_year, period_month }
router.post('/billing/collect-metrics', blockNonDbWrite, async (req, res) => {
    const { period_year, period_month } = req.body || {};
    if (!period_year || !period_month || period_month < 1 || period_month > 12) {
        return res.status(400).json({ error: 'period_year and period_month (1-12) are required' });
    }

    let runRow;
    try {
        const { rows } = await db.query(
            `INSERT INTO billing_metrics_job_runs (period_year, period_month, triggered_by, status)
             VALUES ($1, $2, $3, 'running') RETURNING *`,
            [period_year, period_month, req.staff.id],
        );
        runRow = rows[0];
    } catch (e) { return sendError(res, e, '[admin/billing/collect-metrics]'); }

    try {
        // Lazy require — collectAllTenants() itself requires backend/db,
        // and this file is required by server.js before that module is
        // fully initialized in some test bootstrapping orders.
        const { collectAllTenants } = require('../../jobs/collect-metrics');
        const results = await collectAllTenants(period_year, period_month);

        const allFailed = results.length > 0 && results.every((r) => !r.success);
        const anyFailed = results.some((r) => !r.success);
        const status = allFailed ? 'failed' : anyFailed ? 'partial_failure' : 'success';

        const { rows: updated } = await db.query(
            `UPDATE billing_metrics_job_runs SET status = $1, results = $2, completed_at = NOW() WHERE id = $3 RETURNING *`,
            [status, JSON.stringify(results), runRow.id],
        );
        res.json({ success: true, data: updated[0] });
    } catch (e) {
        await db.query(
            `UPDATE billing_metrics_job_runs SET status = 'failed', results = $1, completed_at = NOW() WHERE id = $2`,
            [JSON.stringify({ error: e.message }), runRow.id],
        ).catch(() => {}); // best-effort — the real failure below is what the caller sees regardless
        sendError(res, e, '[admin/billing/collect-metrics]');
    }
});

// GET /api/admin/billing/job-runs — most recent runs, enriched with who triggered them
router.get('/billing/job-runs', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const users = req.db.fileDb.find('amr_users');
            const rows = req.db.fileDb.find('billing_metrics_job_runs')
                .slice()
                .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
                .slice(0, 100)
                .map((r) => {
                    const u = users.find((u) => u.id == r.triggered_by);
                    return { ...r, triggered_by_name: u?.name || null, triggered_by_email: u?.email || null };
                });
            return res.json({ success: true, data: rows });
        }
        const { rows } = await db.query(`
            SELECT r.*, u.name AS triggered_by_name, u.email AS triggered_by_email
            FROM billing_metrics_job_runs r
            LEFT JOIN amr_users u ON u.id = r.triggered_by
            ORDER BY r.started_at DESC
            LIMIT 100
        `);
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[admin/billing/job-runs]'); }
});

// ── Sync ──────────────────────────────────────────────────────────────────────

// GET /api/admin/sync-tables — the list of tables eligible for DB→file sync
// (metadata/manifest.json), so the admin-health.html button can drive the
// per-table loop below without hardcoding the table list client-side.
router.get('/sync-tables', (req, res) => {
    const manifest = require('../../metadata/manifest.json');
    res.json({ success: true, data: manifest.tables });
});

// POST /api/admin/sync-from-db/:table — re-exports ONE table from the live DB
// to transactiondata/<table>.json on demand. Deliberately one table per
// request rather than looping every manifest table inside a single request
// (the previous design) — that risked ApiFn's 29s Lambda timeout and a large
// aggregate response as the number/size of tables grows. admin-health.html's
// "Sync DB → Files" button now drives the per-table loop itself (sequential
// fetch calls), so every individual Lambda invocation stays small and bounded
// regardless of how many tables or rows exist. There is deliberately no
// files→DB direction anymore — transactiondata/ is meant to stay a DB-derived
// read-only mirror, not a source of truth pushed back into the DB (see
// project-db-write-file-mirror.md). Reuses backend/db.js's mirrorTableToFile(),
// the same per-table logic the automatic write-mirror uses after every write.
router.post('/sync-from-db/:table', async (req, res) => {
    if (req.db.mode === 'nondb') {
        return res.status(400).json({ error: 'Server is running in NonDB mode — no database to sync from.' });
    }
    const manifest = require('../../metadata/manifest.json');
    const { table } = req.params;
    if (!manifest.tables.includes(table)) {
        return res.status(400).json({ error: `Unknown table "${table}"` });
    }
    try {
        const rows = await db.mirrorTableToFile(table);
        await db.updateSyncProgress(table, { success: true, rows, synced_at: new Date().toISOString() });
        res.json({ success: true, table, rows });
    } catch (e) {
        // Best-effort: a failure recording progress must never mask the real
        // sync failure being reported below.
        await db.updateSyncProgress(table, { success: false, error: e.message, synced_at: new Date().toISOString() }).catch(() => {});
        res.status(500).json({ success: false, table, error: e.message });
    }
});

// GET /api/admin/sync-progress — .progress.json's current contents (per-table
// success/failure + timestamp from the most recent sync-from-db run), so
// admin-health.html can show "last synced" per table and recover mid-sync
// state after a page reload — see db.js's updateSyncProgress() comment.
router.get('/sync-progress', async (req, res) => {
    if (req.db.mode === 'nondb') {
        return res.json({ success: true, data: { tables: {} } });
    }
    try {
        const progress = await db.readSyncProgress();
        res.json({ success: true, data: progress });
    } catch (e) { sendError(res, e, '[admin/sync-progress]'); }
});

// GET /api/admin/sync-from-db/download — zips up whatever mirrorTableToFile()
// has synced so far and streams it back. In production this is the only way
// to actually retrieve the synced snapshot: ApiFn writes it to
// TRANSACTIONDATA_S3_BUCKET (Lambda's own filesystem is read-only — see
// project-nondb-read-only.md), so there's no local file for an admin to just
// go look at. Locally (no bucket configured) this reads straight off
// TRANSACTIONDATA_DIR instead, via the same db.readMirroredTableFile().
router.get('/sync-from-db/download', async (req, res) => {
    if (req.db.mode === 'nondb') {
        return res.status(400).json({ error: 'Server is running in NonDB mode — no database to sync from.' });
    }
    const manifest = require('../../metadata/manifest.json');
    try {
        // See email.js's identical comment: archiver@8 is pure ESM, and a
        // synchronous require() of it crashes on the nodejs22.x Lambda runtime.
        const { ZipArchive } = await import('archiver');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="transactiondata.zip"');
        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('error', (err) => {
            console.error('[admin/sync-from-db/download] zip error', err.message);
            if (!res.headersSent) res.status(500).end();
        });
        archive.pipe(res);

        for (const table of manifest.tables) {
            try {
                const content = await db.readMirroredTableFile(table);
                if (content != null) archive.append(content, { name: `${table}.json` });
            } catch (e) {
                console.error(`[admin/sync-from-db/download] skipping ${table}:`, e.message);
            }
        }
        await archive.finalize();
    } catch (e) {
        console.error('[admin/sync-from-db/download]', e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
});

// ── System health & versions ──────────────────────────────────────────────────

// GET /api/admin/health — versions, environment, per-table row counts
router.get('/health', async (req, res) => {
    const TABLES = [
        'amr_users', 'amr_roles', 'amr_groups', 'amr_group_members', 'group_tenant',
        'tenants', 'tenant_subscriptions', 'subscription_plans',
        'invoices', 'invoice_line_items', 'billing_metrics',
        'enhancements', 'payments', 'contact_submissions', 'amr_password_reset_tokens',
    ];

    try {
        if (req.db.mode === 'nondb') {
            const tables = {};
            for (const t of TABLES) {
                try { tables[t] = req.db.fileDb.count(t); } catch { tables[t] = null; }
            }
            return res.json({
                success: true, data: {
                    versions: { api: APP_VERSION, ui: APP_VERSION, db: 'nondb' },
                    environment: process.env.NODE_ENV || 'development',
                    mode: 'nondb',
                    tables,
                },
            });
        }

        const [migRow, ...countRows] = await Promise.all([
            db.query('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
                .catch(() => ({ rows: [] })),
            ...TABLES.map(t =>
                db.query(`SELECT COUNT(*) AS n FROM ${t}`)
                    .then(r => ({ table: t, n: Number(r.rows[0].n) }))
                    .catch(() => ({ table: t, n: null }))
            ),
        ]);

        const latestMigration = migRow.rows[0] || null;
        const tables = {};
        for (const { table, n } of countRows) tables[table] = n;

        res.json({
            success: true, data: {
                versions: {
                    api: APP_VERSION,
                    ui:  APP_VERSION,
                    db:  latestMigration?.version || 'unknown',
                    dbAppliedAt: latestMigration?.applied_at || null,
                },
                environment: process.env.NODE_ENV || 'development',
                mode: 'db',
                tables,
            },
        });
    } catch (err) {
        sendError(res, err, '[admin/health]');
    }
});

function _safeUser(u) {
    const { password_hash, ...safe } = u;
    return safe;
}

module.exports = router;
