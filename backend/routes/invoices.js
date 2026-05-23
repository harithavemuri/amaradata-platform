const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// POST /api/invoices  (generate invoice from billing metrics)
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, period_year, period_month, issue_date, due_date, notes, line_items = [] } = req.body;
    if (!tenant_id || !issue_date || !due_date)
        return res.status(400).json({ error: 'tenant_id, issue_date, due_date required' });
    try {
        const subtotal = line_items.reduce((s, l) => s + Number(l.amount || 0), 0);
        const tax_pct  = 18;
        const tax      = +(subtotal * tax_pct / 100).toFixed(2);
        const total    = +(subtotal + tax).toFixed(2);

        if (req.db.mode === 'nondb') {
            const count = req.db.fileDb.count('invoices');
            const num   = `AMR-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
            const inv   = req.db.fileDb.create('invoices', {
                invoice_number: num, tenant_id, period_year: period_year||null,
                period_month: period_month||null, issue_date, due_date, status: 'draft',
                subtotal, tax_pct, tax_amount: tax, total_amount: total,
                notes: notes||null, created_by: req.staff?.id || null,
            });
            for (let i = 0; i < line_items.length; i++) {
                const l = line_items[i];
                req.db.fileDb.create('invoice_line_items', {
                    invoice_id: inv.id, billing_type: l.billing_type, description: l.description,
                    quantity: l.quantity||1, unit_price: l.unit_price||0, amount: l.amount||0, sort_order: i,
                });
            }
            return res.status(201).json({ success: true, data: inv });
        }
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
                [inv.id, l.billing_type, l.description, l.quantity||1, l.unit_price||0, l.amount||0, i]
            );
        }
        res.status(201).json({ success: true, data: inv });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/invoices/:id/status
router.patch('/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    const valid = ['draft','sent','paid','overdue','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        const paid_at = status === 'paid' ? new Date().toISOString() : null;
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('invoices', req.params.id, { status, paid_at });
            if (!row) return res.status(404).json({ error: 'Not found' });
            return res.json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `UPDATE invoices SET status=$1, paid_at=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
            [status, paid_at, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
