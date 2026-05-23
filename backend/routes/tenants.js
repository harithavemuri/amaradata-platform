const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// POST /api/tenants
router.post('/', requireAdmin, async (req, res) => {
    const { name, slug, contact_name, contact_email, contact_phone, billing_address,
            gstin, pan, status, tenant_db_host, tenant_db_port, tenant_db_name,
            tenant_db_user, tenant_db_secret_arn, tenant_db_password, onboarded_at, notes, site_url } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.create('tenants', {
                name, slug, contact_name, contact_email, contact_phone, billing_address,
                gstin, pan, status: status || 'active', tenant_db_host,
                tenant_db_port: tenant_db_port || 5432, tenant_db_name, tenant_db_user,
                tenant_db_secret_arn: tenant_db_secret_arn || null,
                tenant_db_password: tenant_db_password || null,
                onboarded_at: onboarded_at || null, notes,
                site_url: site_url || null,
            });
            return res.status(201).json({ success: true, data: row });
        }
        const { rows } = await db.query(
            `INSERT INTO tenants (name,slug,contact_name,contact_email,contact_phone,billing_address,
             gstin,pan,status,tenant_db_host,tenant_db_port,tenant_db_name,tenant_db_user,
             tenant_db_secret_arn,tenant_db_password,onboarded_at,notes,site_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
            [name,slug,contact_name,contact_email,contact_phone,billing_address,
             gstin,pan,status||'active',tenant_db_host,tenant_db_port||5432,tenant_db_name,
             tenant_db_user,tenant_db_secret_arn||null,tenant_db_password||null,onboarded_at||null,notes,site_url||null]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/tenants/:id
router.put('/:id', requireAdmin, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    try {
        if (req.db.mode === 'nondb') {
            const row = req.db.fileDb.update('tenants', req.params.id, updates);
            if (!row) return res.status(404).json({ error: 'Not found' });
            return res.json({ success: true, data: row });
        }
        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE tenants SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
            [...vals, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
