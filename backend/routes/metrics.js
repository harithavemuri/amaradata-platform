const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');

// POST /api/metrics  (manual upsert — normally done by collect-metrics job)
router.post('/', requireAuth, async (req, res) => {
    const { tenant_id, period_year, period_month,
            sales_count, sales_value, rental_units, rental_income, active_properties } = req.body;
    if (!tenant_id || !period_year || !period_month)
        return res.status(400).json({ error: 'tenant_id, period_year, period_month required' });
    try {
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('billing_metrics').find(
                r => r.tenant_id == tenant_id && r.period_year == period_year && r.period_month == period_month
            );
            const data = {
                tenant_id, period_year, period_month,
                sales_count: sales_count||0, sales_value: sales_value||0,
                rental_units: rental_units||0, rental_income: rental_income||0,
                active_properties: active_properties||0, collected_at: new Date().toISOString(),
            };
            const row = existing
                ? req.db.fileDb.update('billing_metrics', existing.id, data)
                : req.db.fileDb.create('billing_metrics', data);
            return res.status(201).json({ success: true, data: row });
        }
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
