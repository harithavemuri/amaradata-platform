const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/tenants
router.get('/', requireAuth, async (req, res) => {
    try {
        const { status } = req.query;
        let sql = 'SELECT id,name,slug,contact_name,contact_email,contact_phone,status,onboarded_at,created_at FROM tenants WHERE 1=1';
        const params = [];
        if (status) { sql += ' AND status=$1'; params.push(status); }
        sql += ' ORDER BY name';
        const { rows } = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tenants/:id
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT t.*,
                    s.name AS plan_name, ts.custom_sales_pct, ts.custom_rental_pct,
                    ts.custom_hourly_rate, ts.effective_from
             FROM tenants t
             LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.effective_to IS NULL
             LEFT JOIN subscription_plans s    ON s.id = ts.plan_id
             WHERE t.id = $1`, [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tenants
router.post('/', requireAdmin, async (req, res) => {
    const { name, slug, contact_name, contact_email, contact_phone, billing_address,
            gstin, pan, status, tenant_db_host, tenant_db_port, tenant_db_name,
            tenant_db_user, tenant_db_password, onboarded_at, notes } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO tenants (name,slug,contact_name,contact_email,contact_phone,billing_address,
             gstin,pan,status,tenant_db_host,tenant_db_port,tenant_db_name,tenant_db_user,
             tenant_db_password,onboarded_at,notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
            [name,slug,contact_name,contact_email,contact_phone,billing_address,
             gstin,pan,status||'active',tenant_db_host,tenant_db_port||5432,tenant_db_name,
             tenant_db_user,tenant_db_password,onboarded_at||null,notes]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/tenants/:id
router.put('/:id', requireAdmin, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    updates.updated_at = new Date().toISOString();
    const keys   = Object.keys(updates);
    const vals   = Object.values(updates);
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    try {
        const { rows } = await db.query(
            `UPDATE tenants SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
