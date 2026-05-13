const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/subscriptions/plans
router.get('/plans', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM subscription_plans ORDER BY name');
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subscriptions/plans
router.post('/plans', requireAdmin, async (req, res) => {
    const { name, description, sales_pct, rental_pct, hourly_rate, min_monthly_fee, currency_code } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO subscription_plans (name,description,sales_pct,rental_pct,hourly_rate,min_monthly_fee,currency_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, description, sales_pct||0, rental_pct||0, hourly_rate||0, min_monthly_fee||0, currency_code||'INR']
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/subscriptions?tenant_id=
router.get('/', requireAuth, async (req, res) => {
    try {
        const { tenant_id } = req.query;
        let sql = `SELECT ts.*, t.name AS tenant_name, p.name AS plan_name
                   FROM tenant_subscriptions ts
                   JOIN tenants t ON t.id = ts.tenant_id
                   JOIN subscription_plans p ON p.id = ts.plan_id
                   WHERE 1=1`;
        const params = [];
        if (tenant_id) { sql += ' AND ts.tenant_id=$1'; params.push(tenant_id); }
        sql += ' ORDER BY ts.effective_from DESC';
        const { rows } = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/subscriptions  (assign plan to tenant, closes previous)
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, plan_id, effective_from, custom_sales_pct, custom_rental_pct,
            custom_hourly_rate, custom_min_fee, notes } = req.body;
    if (!tenant_id || !plan_id || !effective_from) {
        return res.status(400).json({ error: 'tenant_id, plan_id, effective_from required' });
    }
    try {
        // Close previous active subscription
        await db.query(
            `UPDATE tenant_subscriptions SET effective_to = $1
             WHERE tenant_id = $2 AND effective_to IS NULL`,
            [effective_from, tenant_id]
        );
        const { rows } = await db.query(
            `INSERT INTO tenant_subscriptions
             (tenant_id,plan_id,effective_from,custom_sales_pct,custom_rental_pct,custom_hourly_rate,custom_min_fee,notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [tenant_id, plan_id, effective_from, custom_sales_pct||null, custom_rental_pct||null,
             custom_hourly_rate||null, custom_min_fee||null, notes]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
