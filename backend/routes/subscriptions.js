const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/subscriptions/plans
router.get('/plans', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('subscription_plans') });
        }
        const { rows } = await db.query('SELECT * FROM subscription_plans ORDER BY name');
        res.json({ success: true, data: rows });
    } catch (e) { console.error('[subscriptions]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/subscriptions/plans
router.post('/plans', requireAdmin, async (req, res) => {
    const { name, description, sales_pct, rental_pct, hourly_rate, min_monthly_fee, currency_code } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.create('subscription_plans', {
                name, description, sales_pct: sales_pct||0, rental_pct: rental_pct||0,
                hourly_rate: hourly_rate||0, min_monthly_fee: min_monthly_fee||0,
                currency_code: currency_code||'INR', is_active: true,
            });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `INSERT INTO subscription_plans (name,description,sales_pct,rental_pct,hourly_rate,min_monthly_fee,currency_code)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, description, sales_pct||0, rental_pct||0, hourly_rate||0, min_monthly_fee||0, currency_code||'INR']
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { console.error('[subscriptions]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/subscriptions/plans/:id
router.delete('/plans/:id', requireAdmin, async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            // FileDbService has no FK enforcement, so the in-use check that Postgres
            // gives us for free (23503) has to be done manually here to keep
            // behavior consistent between modes.
            const inUse = req.db.fileDb.find('tenant_subscriptions').some(s => s.plan_id == req.params.id);
            if (inUse) return res.status(409).json({ error: 'Cannot delete: plan is assigned to one or more tenant subscriptions' });
            const row = req.db.fileDb.delete('subscription_plans', req.params.id);
            if (!row) return res.status(404).json({ error: 'Not found' });
            return res.json({ success: true, data: row });
        }
        const { rows } = await db.query('DELETE FROM subscription_plans WHERE id=$1 RETURNING *', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23503') return res.status(409).json({ error: 'Cannot delete: plan is assigned to one or more tenant subscriptions' });
        console.error('[subscriptions]', e.message); res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/subscriptions  (assign plan to tenant, closes previous)
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, plan_id, effective_from, custom_sales_pct, custom_rental_pct,
            custom_hourly_rate, custom_min_fee, notes } = req.body;
    if (!tenant_id || !plan_id || !effective_from)
        return res.status(400).json({ error: 'tenant_id, plan_id, effective_from required' });
    try {
        if (req.db.mode === 'nondb') {
            const active = req.db.fileDb.find('tenant_subscriptions').filter(
                s => s.tenant_id == tenant_id && s.effective_to == null
            );
            for (const s of active) {
                req.db.fileDb.update('tenant_subscriptions', s.id, { effective_to: effective_from });
            }
            const row = req.db.fileDb.create('tenant_subscriptions', {
                tenant_id, plan_id, effective_from, effective_to: null,
                custom_sales_pct: custom_sales_pct||null, custom_rental_pct: custom_rental_pct||null,
                custom_hourly_rate: custom_hourly_rate||null, custom_min_fee: custom_min_fee||null, notes,
            });
            return res.status(201).json({ success: true, data: row });
        }
        await db.query(
            `UPDATE tenant_subscriptions SET effective_to = $1 WHERE tenant_id = $2 AND effective_to IS NULL`,
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
    } catch (e) { console.error('[subscriptions]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
