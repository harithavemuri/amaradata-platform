const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireSiteAdmin } = require('../middleware/auth');
const { version: APP_VERSION } = require('../../package.json');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');

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

        const { rows } = await db.query(
            `INSERT INTO amr_users (username,email,name,first_name,last_name,role,password_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id,username,email,name,first_name,last_name,role,is_active,created_at`,
            [username, email, name, fn, ln, role, password_hash]
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
