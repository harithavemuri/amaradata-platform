const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/enhancements
router.get('/', requireAuth, async (req, res) => {
    try {
        const { tenant_id, status } = req.query;
        let sql = `SELECT e.*, t.name AS tenant_name
                   FROM enhancements e JOIN tenants t ON t.id = e.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND e.tenant_id=$${n++}`; params.push(tenant_id); }
        if (status)    { sql += ` AND e.status=$${n++}`;    params.push(status); }
        sql += ' ORDER BY e.created_at DESC';
        const { rows } = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/enhancements
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, title, description, billing_type, estimated_hours,
            hourly_rate, milestone_amount, notes } = req.body;
    if (!tenant_id || !title) return res.status(400).json({ error: 'tenant_id, title required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO enhancements (tenant_id,title,description,billing_type,estimated_hours,
             hourly_rate,milestone_amount,notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [tenant_id, title, description, billing_type||'hourly', estimated_hours||null,
             hourly_rate||null, milestone_amount||null, notes]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/enhancements/:id
router.put('/:id', requireAdmin, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    updates.updated_at = new Date().toISOString();
    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    try {
        const { rows } = await db.query(
            `UPDATE enhancements SET ${sets} WHERE id=$${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
