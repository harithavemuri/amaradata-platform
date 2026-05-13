const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/invoices
router.get('/', requireAuth, async (req, res) => {
    try {
        const { tenant_id, status } = req.query;
        let sql = `SELECT i.*, t.name AS tenant_name
                   FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE 1=1`;
        const params = [];
        let n = 1;
        if (tenant_id) { sql += ` AND i.tenant_id=$${n++}`; params.push(tenant_id); }
        if (status)    { sql += ` AND i.status=$${n++}`;    params.push(status); }
        sql += ' ORDER BY i.issue_date DESC';
        const { rows } = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/invoices/:id  (with line items)
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const { rows: [inv] } = await db.query(
            `SELECT i.*, t.name AS tenant_name, t.contact_email, t.gstin, t.billing_address
             FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id=$1`, [req.params.id]
        );
        if (!inv) return res.status(404).json({ error: 'Not found' });
        const { rows: items } = await db.query(
            'SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order', [req.params.id]
        );
        res.json({ success: true, data: { ...inv, line_items: items } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invoices  (generate invoice from billing metrics)
router.post('/', requireAdmin, async (req, res) => {
    const { tenant_id, period_year, period_month, issue_date, due_date, notes, line_items = [] } = req.body;
    if (!tenant_id || !issue_date || !due_date) {
        return res.status(400).json({ error: 'tenant_id, issue_date, due_date required' });
    }
    try {
        // Generate invoice number
        const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM invoices');
        const num = `AMR-${new Date().getFullYear()}-${String(parseInt(count) + 1).padStart(4, '0')}`;

        const subtotal = line_items.reduce((s, l) => s + Number(l.amount || 0), 0);
        const tax_pct  = 18;
        const tax      = +(subtotal * tax_pct / 100).toFixed(2);
        const total    = +(subtotal + tax).toFixed(2);

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
        const { rows } = await db.query(
            `UPDATE invoices SET status=$1, paid_at=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
            [status, paid_at, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
