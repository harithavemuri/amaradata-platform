const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');

// GET /api/enhancements
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('enhancements') });
        }
        const { rows } = await db.query('SELECT * FROM enhancements ORDER BY created_at DESC');
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[enhancements]'); }
});

// POST /api/enhancements
router.post('/', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { tenant_id, title, description, billing_type, estimated_hours,
            actual_hours, hourly_rate, milestone_amount, delivered_at, notes,
            item_type, is_billable } = req.body;
    if (!tenant_id || !title) return res.status(400).json({ error: 'tenant_id, title required' });
    const row = {
        tenant_id, title, description,
        billing_type:     billing_type || 'hourly',
        status:           'scoped',
        estimated_hours:  estimated_hours  || null,
        actual_hours:     actual_hours     || null,
        hourly_rate:      hourly_rate      || null,
        milestone_amount: milestone_amount || null,
        delivered_at:     delivered_at     || null,
        notes,
        source:      'manual',
        item_type:   item_type   || 'enhancement',
        is_billable: is_billable !== undefined ? is_billable : true,
    };
    try {
        const { rows } = await db.query(
            `INSERT INTO enhancements
             (tenant_id,title,description,billing_type,estimated_hours,actual_hours,
              hourly_rate,milestone_amount,delivered_at,notes,source,item_type,is_billable)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,$12) RETURNING *`,
            [tenant_id, title, description, row.billing_type, row.estimated_hours,
             row.actual_hours, row.hourly_rate, row.milestone_amount, row.delivered_at,
             notes, row.item_type, row.is_billable]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[enhancements]'); }
});

// PUT /api/enhancements/:id
router.put('/:id', requireAdmin, blockNonDbWrite, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    updates.updated_at = new Date().toISOString();
    try {
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE enhancements SET ${sets} WHERE id=$${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[enhancements]'); }
});

// POST /api/enhancements/import  — bulk upsert from RohasTestNotesSheet_Fixed.csv
// Body: { tenant_id?, tenant_name?, rows: [...] }
// tenant_id takes precedence; tenant_name is used to look it up when tenant_id is absent.
router.post('/import', requireAdmin, blockNonDbWrite, async (req, res) => {
    let { tenant_id, tenant_name, rows: csvRows } = req.body;

    // Resolve tenant by name if tenant_id not provided
    if (!tenant_id && tenant_name) {
        try {
            const { rows } = await db.query(
                `SELECT id FROM tenants WHERE lower(name)=lower($1) LIMIT 1`, [tenant_name]
            );
            if (rows[0]) tenant_id = rows[0].id;
        } catch (_) { /* fall through to error below */ }
    }
    if (!tenant_id)           return res.status(400).json({ error: 'tenant_id required' });
    if (!Array.isArray(csvRows) || csvRows.length === 0)
        return res.status(400).json({ error: 'rows array required' });

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (const r of csvRows) {
        if (!r.issue_id) { results.skipped++; continue; }
        const title       = (r.notes || '').slice(0, 200) || `Issue #${r.issue_id}`;
        const billable    = r.is_billable === true || r.is_billable === 'Yes' || r.is_billable === 'yes';
        const itype       = (r.item_type || 'enhancement').toLowerCase();
        const delivered   = r.fixed && r.fixed.toLowerCase().startsWith('yes') ? (r.report_date || null) : null;
        const status      = r.fixed && r.fixed.toLowerCase().startsWith('yes') ? 'delivered'
                          : r.fixed && r.fixed.toLowerCase().startsWith('skip') ? 'cancelled'
                          : 'scoped';

        try {
            const { rows } = await db.query(
                `INSERT INTO enhancements
                 (tenant_id,title,description,billing_type,status,delivered_at,notes,
                  source,issue_id,site_name,fixed,item_type,is_billable,report_date)
                 VALUES ($1,$2,$3,'fixed',$4,$5,$6,'csv',$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (tenant_id,issue_id) DO UPDATE SET
                   title=EXCLUDED.title, description=EXCLUDED.description,
                   notes=EXCLUDED.notes, item_type=EXCLUDED.item_type,
                   is_billable=EXCLUDED.is_billable, fixed=EXCLUDED.fixed,
                   site_name=EXCLUDED.site_name, status=EXCLUDED.status,
                   delivered_at=EXCLUDED.delivered_at, report_date=EXCLUDED.report_date,
                   updated_at=NOW()
                 RETURNING (xmax = 0) AS inserted`,
                [tenant_id, title, r.notes, status, delivered, r.fix_details || null,
                 r.issue_id, r.site_name || null, r.fixed || null,
                 itype, billable, r.report_date || null]
            );
            rows[0]?.inserted ? results.inserted++ : results.updated++;
        } catch (e) {
            results.errors.push({ issue_id: r.issue_id, error: e.message });
        }
    }

    res.json({ success: true, data: results });
});

// DELETE /api/enhancements/:id
router.delete('/:id', requireAdmin, blockNonDbWrite, async (req, res) => {
    try {
        const { rows } = await db.query('DELETE FROM enhancements WHERE id=$1 RETURNING *', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[enhancements]'); }
});

module.exports = router;
