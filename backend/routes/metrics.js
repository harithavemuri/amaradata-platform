const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/metrics?tenant_id=&year=&month=
router.get('/', requireAuth, async (req, res) => {
    try {
        const { tenant_id, year, month } = req.query;
        let sql = `SELECT m.*, t.name AS tenant_name
                   FROM billing_metrics m JOIN tenants t ON t.id = m.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND m.tenant_id=$${n++}`; params.push(tenant_id); }
        if (year)      { sql += ` AND m.period_year=$${n++}`;  params.push(year); }
        if (month)     { sql += ` AND m.period_month=$${n++}`; params.push(month); }
        sql += ' ORDER BY m.period_year DESC, m.period_month DESC';
        const { rows } = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/metrics  (manual upsert — normally done by collect-metrics job)
router.post('/', requireAuth, async (req, res) => {
    const { tenant_id, period_year, period_month,
            sales_count, sales_value, rental_units, rental_income, active_properties } = req.body;
    if (!tenant_id || !period_year || !period_month) {
        return res.status(400).json({ error: 'tenant_id, period_year, period_month required' });
    }
    try {
        const { rows } = await db.query(
            `INSERT INTO billing_metrics
             (tenant_id,period_year,period_month,sales_count,sales_value,rental_units,rental_income,active_properties)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, period_year, period_month)
             DO UPDATE SET sales_count=$4, sales_value=$5, rental_units=$6,
                           rental_income=$7, active_properties=$8, collected_at=NOW()
             RETURNING *`,
            [tenant_id, period_year, period_month,
             sales_count||0, sales_value||0, rental_units||0, rental_income||0, active_properties||0]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
