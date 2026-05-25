const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireSiteAdmin } = require('../middleware/auth');

const VALID_ROLES = ['site_admin', 'admin', 'sales_manager', 'billing', 'staff'];

// All admin routes require site_admin
router.use(requireSiteAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users  — enriched with group memberships
router.get('/users', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const rows    = req.db.fileDb.find('amr_users');
            const members = req.db.fileDb.find('amr_user_group_members');
            const groups  = req.db.fileDb.find('amr_user_groups');
            const enriched = rows.map(u => {
                const userGroups = members
                    .filter(m => m.user_id == u.id)
                    .map(m => {
                        const g = groups.find(g => g.id == m.group_id);
                        return g ? { id: g.id, name: g.name, role: g.role || null } : null;
                    })
                    .filter(Boolean);
                return { ..._safeUser(u), groups: userGroups };
            });
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT u.id, u.email, u.name, u.role, u.google_id, u.picture,
                   u.is_active, u.last_login_at, u.created_at, u.updated_at,
                   COALESCE(json_agg(json_build_object('id',g.id,'name',g.name,'role',g.role))
                     FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
            FROM amr_users u
            LEFT JOIN amr_user_group_members m ON m.user_id = u.id
            LEFT JOIN amr_user_groups g ON g.id = m.group_id
            GROUP BY u.id ORDER BY u.created_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
    const { email, name, role = 'staff', password } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    try {
        const password_hash = password ? await bcrypt.hash(password, 12) : '';
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_users', { email });
            if (existing.length) return res.status(409).json({ error: 'Email already exists' });
            const row = req.db.fileDb.create('amr_users', { email, name, role, password_hash, is_active: true });
            return res.status(201).json({ success: true, data: _safeUser(row) });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role,is_active,created_at',
            [email, name, role, password_hash]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
    const { name, role, is_active, password } = req.body;
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

    try {
        const updates = {};
        if (name      !== undefined) updates.name      = name;
        if (role      !== undefined) updates.role      = role;
        if (is_active !== undefined) updates.is_active = is_active;
        if (password)                updates.password_hash = await bcrypt.hash(password, 12);

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
            `UPDATE amr_users SET ${sets} WHERE id = $${keys.length + 1} RETURNING id,email,name,role,is_active,updated_at`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User Groups ───────────────────────────────────────────────────────────────

// GET /api/admin/user-groups  — enriched with members and their is_active status
router.get('/user-groups', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const groups  = req.db.fileDb.find('amr_user_groups');
            const members = req.db.fileDb.find('amr_user_group_members');
            const users   = req.db.fileDb.find('amr_users');
            const enriched = groups.map(g => ({
                ...g,
                member_count: members.filter(m => m.group_id == g.id).length,
                members: members
                    .filter(m => m.group_id == g.id)
                    .map(m => {
                        const u = users.find(u => u.id == m.user_id);
                        return u ? { id: u.id, name: u.name, email: u.email, role: u.role, is_active: u.is_active } : null;
                    })
                    .filter(Boolean),
            }));
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT g.*,
                   COUNT(m.user_id)::int AS member_count,
                   COALESCE(json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'is_active',u.is_active))
                     FILTER (WHERE u.id IS NOT NULL), '[]') AS members
            FROM amr_user_groups g
            LEFT JOIN amr_user_group_members m ON m.group_id = g.id
            LEFT JOIN amr_users u ON u.id = m.user_id
            GROUP BY g.id ORDER BY g.created_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/user-groups
router.post('/user-groups', async (req, res) => {
    const { name, description, role } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.create('amr_user_groups', {
                name, description: description || '', role: role || null, is_active: true, created_by: req.staff.id,
            });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_user_groups (name,description,role,created_by) VALUES ($1,$2,$3,$4) RETURNING *',
            [name, description || '', role || null, req.staff.id]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/user-groups/:id
router.put('/user-groups/:id', async (req, res) => {
    const { name, description, role, is_active } = req.body;
    try {
        const updates = {};
        if (name        !== undefined) updates.name        = name;
        if (description !== undefined) updates.description = description;
        if (role        !== undefined) updates.role        = role || null;
        if (is_active   !== undefined) updates.is_active   = is_active;

        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('amr_user_groups', req.params.id, updates);
            if (!row) return res.status(404).json({ error: 'Group not found' });
            return res.json({ success: true, data: row });
        }
        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE amr_user_groups SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Group not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/user-groups/:id
router.delete('/user-groups/:id', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.delete('amr_user_groups', req.params.id);
            if (!row) return res.status(404).json({ error: 'Group not found' });
            req.db.fileDb.find('amr_user_group_members', { group_id: parseInt(req.params.id) })
                .forEach(m => req.db.fileDb.delete('amr_user_group_members', m.id));
            return res.json({ success: true });
        }
        const { rowCount } = await db.query('DELETE FROM amr_user_groups WHERE id = $1', [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Group not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/user-groups/:id/members  { user_id }
router.post('/user-groups/:id/members', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_user_group_members', { group_id: parseInt(req.params.id), user_id: parseInt(user_id) });
            if (existing.length) return res.status(409).json({ error: 'Already a member' });
            const row = req.db.fileDb.create('amr_user_group_members', { group_id: parseInt(req.params.id), user_id: parseInt(user_id) });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_user_group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *',
            [req.params.id, user_id]
        );
        res.status(201).json({ success: true, data: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/user-groups/:id/members/:userId
router.delete('/user-groups/:id/members/:userId', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const members = req.db.fileDb.find('amr_user_group_members', {
                group_id: parseInt(req.params.id),
                user_id:  parseInt(req.params.userId),
            });
            if (!members.length) return res.status(404).json({ error: 'Member not found' });
            req.db.fileDb.delete('amr_user_group_members', members[0].id);
            return res.json({ success: true });
        }
        const { rowCount } = await db.query(
            'DELETE FROM amr_user_group_members WHERE group_id = $1 AND user_id = $2',
            [req.params.id, req.params.userId]
        );
        if (!rowCount) return res.status(404).json({ error: 'Member not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────

// GET /api/admin/roles  — enriched with direct users and groups that confer this role
router.get('/roles', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const roles  = req.db.fileDb.find('amr_roles');
            const users  = req.db.fileDb.find('amr_users');
            const groups = req.db.fileDb.find('amr_user_groups');
            const enriched = roles.map(r => ({
                ...r,
                user_count: users.filter(u => u.role === r.name).length,
                users: users.filter(u => u.role === r.name)
                            .map(u => ({ id: u.id, name: u.name, email: u.email, is_active: u.is_active })),
                groups: groups.filter(g => g.role === r.name)
                              .map(g => ({ id: g.id, name: g.name, member_count: 0 })),
            }));
            // back-fill member_count on groups
            const members = req.db.fileDb.find('amr_user_group_members');
            enriched.forEach(r => {
                r.groups.forEach(g => {
                    g.member_count = members.filter(m => m.group_id == g.id).length;
                });
            });
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT r.*,
                   COUNT(DISTINCT u.id)::int AS user_count,
                   COALESCE(json_agg(DISTINCT json_build_object('id',u.id,'name',u.name,'email',u.email,'is_active',u.is_active))
                     FILTER (WHERE u.id IS NOT NULL), '[]') AS users,
                   COALESCE((
                     SELECT json_agg(json_build_object('id',g.id,'name',g.name,'member_count',
                       (SELECT COUNT(*)::int FROM amr_user_group_members m WHERE m.group_id = g.id)))
                     FROM amr_user_groups g WHERE g.role = r.name
                   ), '[]') AS groups
            FROM amr_roles r
            LEFT JOIN amr_users u ON u.role = r.name
            GROUP BY r.id ORDER BY r.created_at ASC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sync ──────────────────────────────────────────────────────────────────────

// POST /api/admin/sync-to-db
// Upserts every row from transactiondata/*.json into the live DB.
// Only meaningful when the server is running against a real DB (not nondb mode).
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

    const results = [];

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

        let inserted = 0, updated = 0, errors = 0;
        for (const row of rows) {
            // Strip NonDB-internal and joined fields — only keep primitive DB columns
            const cleaned = Object.fromEntries(
                Object.entries(row).filter(([k, v]) =>
                    k !== '_metadata' && !Array.isArray(v) && (typeof v !== 'object' || v === null)
                )
            );
            if (!cleaned.id) continue;

            const cols = Object.keys(cleaned);
            const vals = Object.values(cleaned);
            // SET clause excludes id and created_at to preserve originals on conflict
            const setCols = cols.filter(c => c !== 'id' && c !== 'created_at');
            const setClause = setCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

            try {
                const result = await db.query(
                    `INSERT INTO ${table} (${cols.join(', ')})
                     VALUES (${placeholders})
                     ON CONFLICT (id) DO UPDATE SET ${setClause}
                     RETURNING (xmax = 0) AS was_inserted`,
                    vals
                );
                result.rows[0]?.was_inserted ? inserted++ : updated++;
            } catch (e) {
                errors++;
                // Log but continue — don't abort the whole sync for one bad row
                console.error(`sync ${table} id=${cleaned.id}: ${e.message}`);
            }
        }
        results.push({ table, rows: rows.length, inserted, updated, errors });
    }

    res.json({ success: true, data: results });
});

function _safeUser(u) {
    const { password_hash, ...safe } = u;
    return safe;
}

module.exports = router;
