const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireSiteAdmin } = require('../middleware/auth');
const { version: APP_VERSION } = require('../../package.json');

const VALID_ROLES = ['site_admin', 'admin', 'sales_manager', 'billing', 'staff'];

// All admin routes require site_admin
router.use(requireSiteAdmin);

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
                       u.role, u.google_id, u.logo_url,
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
                       google_id, logo_url,
                       is_active, last_login_at, created_at, updated_at,
                       '[]'::json AS groups
                FROM amr_users ORDER BY created_at DESC
            `));
        }
        res.json({ success: true, data: rows });
    } catch (e) { console.error('[admin] users:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
    const { email, name, first_name, last_name, role = 'staff', password } = req.body;
    const username = req.body.username || email;
    if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    try {
        const password_hash = password ? await bcrypt.hash(password, 12) : '';
        const fn = first_name || name.split(' ')[0];
        const ln = last_name  || name.split(' ').slice(1).join(' ') || null;

        if (req.db.mode === 'nondb') {
            const uLower = username.toLowerCase();
            const existing = req.db.fileDb.find('amr_users').filter(u => u.username?.toLowerCase() === uLower);
            if (existing.length) return res.status(409).json({ error: 'Username already exists' });
            const row = req.db.fileDb.create('amr_users', {
                username, email, name, first_name: fn, last_name: ln,
                role, password_hash, is_active: true,
            });
            return res.status(201).json({ success: true, data: _safeUser(row) });
        }
        const { rows } = await db.query(
            `INSERT INTO amr_users (username,email,name,first_name,last_name,role,password_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id,username,email,name,first_name,last_name,role,is_active,created_at`,
            [username, email, name, fn, ln, role, password_hash]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
        console.error('[admin] create-user:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
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

        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('amr_users', req.params.id, updates);
            if (!row) return res.status(404).json({ error: 'User not found' });
            return res.json({ success: true, data: _safeUser(row) });
        }
        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE amr_users SET ${sets} WHERE id = $${keys.length + 1}
             RETURNING id,email,name,first_name,last_name,role,is_active,updated_at`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/admin/users/:id  (soft-delete — sets is_active=false)
router.delete('/users/:id', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('amr_users', req.params.id, { is_active: false });
            if (!row) return res.status(404).json({ error: 'User not found' });
            return res.json({ success: true });
        }
        const { rowCount } = await db.query(
            'UPDATE amr_users SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
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
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/user-groups
router.post('/user-groups', async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_groups').find(g => g.name?.toLowerCase() === name.toLowerCase());
            if (existing) return res.status(409).json({ error: 'Group name already exists' });
            const row = req.db.fileDb.create('amr_groups', { name, description: description || '', is_active: true });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_groups (name,description) VALUES ($1,$2) RETURNING *',
            [name, description || '']
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Group name already exists' });
        console.error('[admin]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/admin/user-groups/:id
router.put('/user-groups/:id', async (req, res) => {
    const { name, description, is_active } = req.body;
    try {
        const updates = {};
        if (name        !== undefined) updates.name        = name;
        if (description !== undefined) updates.description = description;
        if (is_active   !== undefined) updates.is_active   = is_active;

        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('amr_groups', req.params.id, updates);
            if (!row) return res.status(404).json({ error: 'Group not found' });
            return res.json({ success: true, data: row });
        }
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
        console.error('[admin]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/admin/user-groups/:id
router.delete('/user-groups/:id', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.delete('amr_groups', req.params.id);
            if (!row) return res.status(404).json({ error: 'Group not found' });
            req.db.fileDb.find('amr_group_members', { group_id: parseInt(req.params.id) })
                .forEach(m => req.db.fileDb.delete('amr_group_members', m.id));
            req.db.fileDb.find('group_tenant', { group_id: parseInt(req.params.id) })
                .forEach(gt => req.db.fileDb.delete('group_tenant', gt.id));
            return res.json({ success: true });
        }
        const { rowCount } = await db.query('DELETE FROM amr_groups WHERE id = $1', [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Group not found' });
        res.json({ success: true });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/user-groups/:id/members  { user_id }
router.post('/user-groups/:id/members', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_group_members', { group_id: parseInt(req.params.id), user_id: parseInt(user_id) });
            if (existing.length) return res.status(409).json({ error: 'Already a member' });
            const row = req.db.fileDb.create('amr_group_members', {
                group_id: parseInt(req.params.id),
                user_id:  parseInt(user_id),
            });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `INSERT INTO amr_group_members (group_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (group_id, user_id) DO NOTHING RETURNING *`,
            [req.params.id, user_id]
        );
        if (!rows[0]) return res.status(409).json({ error: 'Already a member' });
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/admin/user-groups/:id/members/:userId
router.delete('/user-groups/:id/members/:userId', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const members = req.db.fileDb.find('amr_group_members', {
                group_id: parseInt(req.params.id),
                user_id:  parseInt(req.params.userId),
            });
            if (!members.length) return res.status(404).json({ error: 'Member not found' });
            req.db.fileDb.delete('amr_group_members', members[0].id);
            return res.json({ success: true });
        }
        const { rowCount } = await db.query(
            'DELETE FROM amr_group_members WHERE group_id = $1 AND user_id = $2',
            [req.params.id, req.params.userId]
        );
        if (!rowCount) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Group → Tenant assignments (group_tenant) ─────────────────────────────────

// POST /api/admin/user-groups/:id/tenants  { tenant_id, role_id }
router.post('/user-groups/:id/tenants', async (req, res) => {
    const { tenant_id, role_id } = req.body;
    if (!tenant_id || !role_id) return res.status(400).json({ error: 'tenant_id and role_id are required' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('group_tenant', {
                group_id: parseInt(req.params.id), tenant_id: parseInt(tenant_id), role_id: parseInt(role_id),
            });
            if (existing.length) return res.status(409).json({ error: 'Assignment already exists' });
            const row = req.db.fileDb.create('group_tenant', {
                group_id: parseInt(req.params.id), tenant_id: parseInt(tenant_id), role_id: parseInt(role_id),
            });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `INSERT INTO group_tenant (group_id, tenant_id, role_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (group_id, tenant_id, role_id) DO NOTHING RETURNING *`,
            [req.params.id, tenant_id, role_id]
        );
        if (!rows[0]) return res.status(409).json({ error: 'Assignment already exists' });
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/admin/user-groups/:id/tenants/:gtId
router.delete('/user-groups/:id/tenants/:gtId', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const gt = req.db.fileDb.getById('group_tenant', req.params.gtId);
            if (!gt || gt.group_id != req.params.id) return res.status(404).json({ error: 'Assignment not found' });
            req.db.fileDb.delete('group_tenant', req.params.gtId);
            return res.json({ success: true });
        }
        const { rowCount } = await db.query(
            'DELETE FROM group_tenant WHERE id = $1 AND group_id = $2',
            [req.params.gtId, req.params.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ success: true });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
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
    } catch (e) { console.error('[admin] roles:', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/roles
router.post('/roles', async (req, res) => {
    const { name, label, description } = req.body;
    if (!name || !label) return res.status(400).json({ error: 'name and label are required' });
    if (!/^[a-z_]+$/.test(name)) return res.status(400).json({ error: 'name must be lowercase letters and underscores only' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_roles', { name });
            if (existing.length) return res.status(409).json({ error: 'Role name already exists' });
            const row = req.db.fileDb.create('amr_roles', { name, label, description: description || '', is_system: false });
            return res.status(201).json({ success: true, data: row });
        }
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
router.put('/roles/:id', async (req, res) => {
    const { label, description } = req.body;
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.getById('amr_roles', req.params.id);
            if (!existing) return res.status(404).json({ error: 'Role not found' });
            const updates = {};
            if (label       !== undefined) updates.label       = label;
            if (description !== undefined) updates.description = description;
            const row = req.db.fileDb.update('amr_roles', req.params.id, updates);
            return res.json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `UPDATE amr_roles SET label = COALESCE($1, label), description = COALESCE($2, description),
             updated_at = NOW() WHERE id = $3 RETURNING *`,
            [label || null, description !== undefined ? description : null, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Role not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/admin/roles/:id  (system roles cannot be deleted)
router.delete('/roles/:id', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const role = req.db.fileDb.getById('amr_roles', req.params.id);
            if (!role) return res.status(404).json({ error: 'Role not found' });
            if (role.is_system) return res.status(403).json({ error: 'System roles cannot be deleted' });
            const users = req.db.fileDb.find('amr_users', { role: role.name });
            if (users.length) return res.status(409).json({ error: `${users.length} user(s) have this role. Reassign them first.` });
            req.db.fileDb.delete('amr_roles', req.params.id);
            return res.json({ success: true });
        }
        const { rows: [role] } = await db.query('SELECT * FROM amr_roles WHERE id = $1', [req.params.id]);
        if (!role) return res.status(404).json({ error: 'Role not found' });
        if (role.is_system) return res.status(403).json({ error: 'System roles cannot be deleted' });
        const { rows: [{ cnt }] } = await db.query(
            'SELECT COUNT(*)::int AS cnt FROM amr_users WHERE role = $1', [role.name]
        );
        if (cnt > 0) return res.status(409).json({ error: `${cnt} user(s) have this role. Reassign them first.` });
        await db.query('DELETE FROM amr_roles WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { console.error('[admin]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Sync ──────────────────────────────────────────────────────────────────────

// POST /api/admin/sync-to-db
router.post('/sync-to-db', async (req, res) => {
    if (req.db.mode === 'nondb') {
        return res.status(400).json({ error: 'Server is running in NonDB mode — no database to sync to.' });
    }

    const fs       = require('fs');
    const path     = require('path');
    const manifest = require('../../metadata/manifest.json');
    const DATA_DIR = process.env.TRANSACTIONDATA_DIR
        ? path.resolve(process.env.TRANSACTIONDATA_DIR)
        : path.join(__dirname, '../../transactiondata');

    // Pre-load actual DB column names for each table (avoids inserting stale/extra JSON fields)
    const dbCols = {};
    for (const table of manifest.tables) {
        try {
            const { rows: cols } = await db.query(
                `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                [table]
            );
            dbCols[table] = new Set(cols.map(r => r.column_name));
        } catch { dbCols[table] = null; }
    }

    const results = [];
    const BATCH = 200;

    for (const table of manifest.tables) {
        const file = path.join(DATA_DIR, `${table}.json`);
        if (!fs.existsSync(file)) {
            results.push({ table, skipped: true, reason: 'no file' });
            continue;
        }

        let rows;
        try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { results.push({ table, skipped: true, reason: `parse error: ${e.message}` }); continue; }

        if (!rows.length) { results.push({ table, rows: 0, inserted: 0, updated: 0 }); continue; }

        const allowedCols = dbCols[table];

        // Strip non-DB fields and unknown columns from each row
        const cleaned = rows
            .map(r => Object.fromEntries(
                Object.entries(r).filter(([k, v]) =>
                    k !== '_metadata' &&
                    !Array.isArray(v) &&
                    (typeof v !== 'object' || v === null) &&
                    (!allowedCols || allowedCols.has(k))
                )
            ))
            .filter(r => r.id);

        if (!cleaned.length) { results.push({ table, rows: rows.length, inserted: 0, updated: 0 }); continue; }

        // Use the first row's columns as the canonical set for the whole table
        const cols      = Object.keys(cleaned[0]);
        const setCols   = cols.filter(c => c !== 'id' && c !== 'created_at');
        const setClause = setCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

        let inserted = 0, updated = 0, errors = 0;

        for (let i = 0; i < cleaned.length; i += BATCH) {
            const batch = cleaned.slice(i, i + BATCH);
            const vals  = [];
            const rowPlaceholders = batch.map((r, ri) => {
                cols.forEach(c => vals.push(r[c] !== undefined ? r[c] : null));
                return `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ')})`;
            });
            try {
                const result = await db.query(
                    `INSERT INTO ${table} (${cols.join(', ')})
                     VALUES ${rowPlaceholders.join(', ')}
                     ON CONFLICT (id) DO UPDATE SET ${setClause}
                     RETURNING (xmax = 0) AS was_inserted`,
                    vals
                );
                for (const r of result.rows) r.was_inserted ? inserted++ : updated++;
            } catch (e) {
                errors += batch.length;
                console.error(`sync ${table} batch[${i}..${i + batch.length - 1}]: ${e.message}`);
            }
        }
        results.push({ table, rows: rows.length, inserted, updated, errors });

        // Reset sequence so next auto-insert gets an id above the max we just synced
        if (inserted + updated > 0) {
            try {
                await db.query(
                    `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`,
                    [table]
                );
            } catch { /* table may not have a serial id — safe to ignore */ }
        }
    }

    res.json({ success: true, data: results });
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
        console.error('[admin/health]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function _safeUser(u) {
    const { password_hash, ...safe } = u;
    return safe;
}

module.exports = router;
