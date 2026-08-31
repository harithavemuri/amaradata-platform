const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');

// GET /api/invoices
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('invoices') });
        }
        const { rows } = await db.query('SELECT * FROM invoices ORDER BY issue_date DESC');
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[invoices]'); }
});

// Pure computation shared by both DB and NonDB modes below — takes the raw
// metrics row and the resolved subscription+plan fields, returns the same
// { line_items, plan } shape either way, so the response never depends on
// which mode served it (see feedback_api_nondb_architecture: only
// retrieval differs, never the shape).
function computeSuggestedLineItems(metrics, sub, period_year, period_month) {
    const salesPct  = sub.custom_sales_pct  ?? sub.sales_pct;
    const rentalPct = sub.custom_rental_pct ?? sub.rental_pct;
    const minFee    = sub.custom_min_fee    ?? sub.min_monthly_fee;

    const round2 = (n) => Math.round(n * 100) / 100;
    const salesAmount  = round2(Number(metrics.sales_value)   * salesPct  / 100);
    const rentalAmount = round2(Number(metrics.rental_income) * rentalPct / 100);

    const line_items = [];
    if (salesPct > 0) {
        line_items.push({
            description: `Sales commission — ${salesPct}% of ${sub.currency_code} ${metrics.sales_value} (${metrics.sales_count} sale(s), ${period_month}/${period_year})`,
            billing_type: 'sales_pct', quantity: 1, unit_price: salesAmount, amount: salesAmount,
        });
    }
    if (rentalPct > 0) {
        line_items.push({
            description: `Rental commission — ${rentalPct}% of ${sub.currency_code} ${metrics.rental_income} (${metrics.rental_units} unit(s), ${period_month}/${period_year})`,
            billing_type: 'rental_pct', quantity: 1, unit_price: rentalAmount, amount: rentalAmount,
        });
    }
    const subtotal = salesAmount + rentalAmount;
    if (minFee > 0 && subtotal < minFee) {
        const topUp = round2(minFee - subtotal);
        line_items.push({
            description: `Minimum monthly fee adjustment (floor: ${sub.currency_code} ${minFee})`,
            billing_type: 'fixed', quantity: 1, unit_price: topUp, amount: topUp,
        });
    }

    return { line_items, plan: { name: sub.plan_name, sales_pct: salesPct, rental_pct: rentalPct, min_monthly_fee: minFee, currency_code: sub.currency_code } };
}

// GET /api/invoices/suggest-line-items?tenant_id=&period_year=&period_month=
// Computes what a tenant's commission actually is for a period — real math,
// not a manually-typed guess. "Sales %"/"Rental %" in invoices.html's line
// item dropdown used to be pure labels; a staff member had to compute
// sales_value/rental_income × the plan's percentage by hand. This endpoint
// does that computation server-side and returns suggested line items for
// the New Invoice form to pre-fill — staff still reviews/edits before
// POSTing, this never creates an invoice itself.
//
// The subscription used is whichever one was ACTIVE DURING the requested
// period (effective_from <= period end, effective_to NULL or after period
// end) — not just "currently active" — so invoicing a past period after the
// plan has since changed still uses the rate that applied at the time.
router.get('/suggest-line-items', async (req, res) => {
    const tenant_id    = parseInt(req.query.tenant_id, 10);
    const period_year  = parseInt(req.query.period_year, 10);
    const period_month = parseInt(req.query.period_month, 10);
    if (!tenant_id || !period_year || !period_month || period_month < 1 || period_month > 12) {
        return res.status(400).json({ error: 'tenant_id, period_year, and period_month (1-12) are required' });
    }
    try {
        let metrics, sub;

        if (req.db.mode === 'nondb') {
            metrics = req.db.fileDb.find('billing_metrics')
                .find((m) => m.tenant_id == tenant_id && m.period_year == period_year && m.period_month == period_month);
            if (!metrics) {
                return res.status(404).json({ error: `No billing metrics found for this tenant/period — run "Collect Metrics Now" first.` });
            }

            const periodEndMs = new Date(period_year, period_month, 0).getTime();
            const plans = req.db.fileDb.find('subscription_plans');
            sub = req.db.fileDb.find('tenant_subscriptions')
                .filter((s) => s.tenant_id == tenant_id
                    && new Date(s.effective_from).getTime() <= periodEndMs
                    && (!s.effective_to || new Date(s.effective_to).getTime() > periodEndMs))
                .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from))
                .map((s) => {
                    const p = plans.find((p) => p.id == s.plan_id);
                    return p ? { ...s, plan_name: p.name, sales_pct: p.sales_pct, rental_pct: p.rental_pct, min_monthly_fee: p.min_monthly_fee, currency_code: p.currency_code } : null;
                })
                .filter(Boolean)[0];
        } else {
            const { rows: metricsRows } = await db.query(
                `SELECT * FROM billing_metrics WHERE tenant_id = $1 AND period_year = $2 AND period_month = $3`,
                [tenant_id, period_year, period_month],
            );
            metrics = metricsRows[0];
            if (!metrics) {
                return res.status(404).json({ error: `No billing metrics found for this tenant/period — run "Collect Metrics Now" first.` });
            }

            // Last calendar day of the period, so a subscription that's
            // still open (effective_to IS NULL) or ends after this period
            // both count as covering it.
            const periodEnd = new Date(period_year, period_month, 0).toISOString().slice(0, 10);
            const { rows: subRows } = await db.query(
                `SELECT ts.*, p.name AS plan_name, p.sales_pct, p.rental_pct, p.min_monthly_fee, p.currency_code
                 FROM tenant_subscriptions ts
                 JOIN subscription_plans p ON p.id = ts.plan_id
                 WHERE ts.tenant_id = $1
                   AND ts.effective_from <= $2
                   AND (ts.effective_to IS NULL OR ts.effective_to > $2)
                 ORDER BY ts.effective_from DESC LIMIT 1`,
                [tenant_id, periodEnd],
            );
            sub = subRows[0];
        }

        if (!sub) {
            return res.status(400).json({ error: 'No subscription plan found for this tenant covering this period.' });
        }

        const { line_items, plan } = computeSuggestedLineItems(metrics, sub, period_year, period_month);
        res.json({ success: true, data: { line_items, plan, metrics } });
    } catch (e) { sendError(res, e, '[invoices/suggest-line-items]'); }
});

// POST /api/invoices  (generate invoice from billing metrics)
router.post('/', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { tenant_id, period_year, period_month, issue_date, due_date, notes, line_items = [] } = req.body;
    if (!tenant_id || !issue_date || !due_date)
        return res.status(400).json({ error: 'tenant_id, issue_date, due_date required' });
    try {
        const subtotal = line_items.reduce((s, l) => s + Number(l.amount || 0), 0);
        const tax_pct  = 18;
        const tax      = +(subtotal * tax_pct / 100).toFixed(2);
        const total    = +(subtotal + tax).toFixed(2);

        const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM invoices');
        const num = `AMR-${new Date().getFullYear()}-${String(parseInt(count) + 1).padStart(4, '0')}`;
        const { rows: [inv] } = await db.query(
            `INSERT INTO invoices (invoice_number,tenant_id,period_year,period_month,issue_date,due_date,
             subtotal,tax_pct,tax_amount,total_amount,notes,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [num, tenant_id, period_year||null, period_month||null, issue_date, due_date,
             subtotal, tax_pct, tax, total, notes||null, req.staff.id]
        );
        for (let i = 0; i < line_items.length; i++) {
            const l = line_items[i];
            await db.query(
                `INSERT INTO invoice_line_items (invoice_id,billing_type,description,quantity,unit_price,amount,sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [inv.id, l.billing_type||'service', l.description, l.quantity||1, l.unit_price||0, l.amount||0, i]
            );
        }
        res.status(201).json({ success: true, data: inv });
    } catch (e) { sendError(res, e, '[invoices]'); }
});

// PATCH /api/invoices/:id/status
router.patch('/:id/status', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { status } = req.body;
    const valid = ['draft','sent','paid','overdue','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        const paid_at = status === 'paid' ? new Date().toISOString() : null;
        const { rows } = await db.query(
            `UPDATE invoices SET status=$1, paid_at=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
            [status, paid_at, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[invoices]'); }
});

module.exports = router;
