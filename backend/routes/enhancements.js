const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// POST /api/enhancements
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, title, description, billing_type, estimated_hours,
            hourly_rate, milestone_amount, notes } = req.body;
    if (!tenant_id || !title) return res.status(400).json({ error: 'tenant_id, title required' });
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.create('enhancements', {
                tenant_id, title, description, billing_type: billing_type||'hourly',
                status: 'scoped', estimated_hours: estimated_hours||null,
                hourly_rate: hourly_rate||null, milestone_amount: milestone_amount||null, notes,
            });
            return res.status(201).json({ success: true, data: row });
        }
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
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('enhancements', req.params.id, updates);
            if (!row) return res.status(404).json({ error: 'Not found' });
            return res.json({ success: true, data: row });
        }
        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE enhancements SET ${sets} WHERE id=$${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
