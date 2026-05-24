const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { requireSiteAdmin } = require('../middleware/auth');

const VALID_ROLES = ['site_admin', 'admin', 'sales_manager', 'billing', 'staff'];

// All admin routes require site_admin
router.use(requireSiteAdmin);

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const rows = req.db.fileDb.find('amr_users');
            return res.json({ success: true, data: rows.map(_safeUser) });
        }
        const { rows } = await db.query(
            'SELECT id,email,name,role,google_id,picture,is_active,last_login_at,created_at,updated_at FROM amr_users ORDER BY created_at DESC'
        );
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

// GET /api/admin/user-groups
router.get('/user-groups', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const groups = req.db.fileDb.find('amr_user_groups');
            const members = req.db.fileDb.find('amr_user_group_members');
            const users   = req.db.fileDb.find('amr_users');
            const enriched = groups.map(g => ({
                ...g,
                member_count: members.filter(m => m.group_id == g.id).length,
                members: members
                    .filter(m => m.group_id == g.id)
                    .map(m => {
                        const u = users.find(u => u.id == m.user_id);
                        return u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
                    })
                    .filter(Boolean),
            }));
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT g.*,
                   COUNT(m.user_id)::int AS member_count,
                   COALESCE(json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role))
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
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.create('amr_user_groups', { name, description: description || '', is_active: true, created_by: req.staff.id });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_user_groups (name,description,created_by) VALUES ($1,$2,$3) RETURNING *',
            [name, description || '', req.staff.id]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

// GET /api/admin/roles
router.get('/roles', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            const roles = req.db.fileDb.find('amr_roles');
            const users = req.db.fileDb.find('amr_users');
            const enriched = roles.map(r => ({
                ...r,
                user_count: users.filter(u => u.role === r.name).length,
                users: users.filter(u => u.role === r.name)
                            .map(u => ({ id: u.id, name: u.name, email: u.email, is_active: u.is_active })),
            }));
            return res.json({ success: true, data: enriched });
        }
        const { rows } = await db.query(`
            SELECT r.*,
                   COUNT(u.id)::int AS user_count,
                   COALESCE(json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email,'is_active',u.is_active))
                     FILTER (WHERE u.id IS NOT NULL), '[]') AS users
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

function _safeUser(u) {
    const { password_hash, ...safe } = u;
    return safe;
}

module.exports = router;
