const router = require('express').Router();
const db     = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');

// GET /api/metrics
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('billing_metrics') });
        }
        const { rows } = await db.query(
            'SELECT * FROM billing_metrics ORDER BY period_year DESC, period_month DESC'
        );
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[metrics]'); }
});

// POST /api/metrics  (manual upsert — normally done by collect-metrics job)
router.post('/', requireAuth, blockNonDbWrite, async (req, res) => {
    const { tenant_id, period_year, period_month,
            sales_count, sales_value, rental_units, rental_income, active_properties } = req.body;
    if (!tenant_id || !period_year || !period_month)
        return res.status(400).json({ error: 'tenant_id, period_year, period_month required' });
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
    } catch (e) { sendError(res, e, '[metrics]'); }
});

module.exports = router;
