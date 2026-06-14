const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /api/tenants/mine — returns only tenants the current user is eligible to see
router.get('/mine', requireAuth, async (req, res) => {
    try {
        if (req.staff.role === 'site_admin') {
            if (req.db.mode === 'nondb') {
                return res.json({ success: true, data: req.db.fileDb.find('tenants').sort((a,b) => a.name.localeCompare(b.name)) });
            }
            const { rows } = await db.query('SELECT id, name, slug, status FROM tenants ORDER BY name');
            return res.json({ success: true, data: rows });
        }

        if (req.db.mode === 'nondb') {
            const myGroupIds = new Set(
                req.db.fileDb.find('amr_group_members').filter(m => m.user_id == req.staff.id).map(m => m.group_id)
            );
            const myTenantIds = new Set(
                req.db.fileDb.find('group_tenant').filter(gt => myGroupIds.has(gt.group_id)).map(gt => gt.tenant_id)
            );
            const tenants = req.db.fileDb.find('tenants')
                .filter(t => myTenantIds.has(t.id))
                .sort((a, b) => a.name.localeCompare(b.name));
            return res.json({ success: true, data: tenants });
        }

        const { rows } = await db.query(
            `SELECT DISTINCT t.id, t.name, t.slug, t.status
             FROM tenants t
             JOIN group_tenant gt ON gt.tenant_id = t.id
             JOIN amr_group_members m ON m.group_id = gt.group_id
             WHERE m.user_id = $1
             ORDER BY t.name`,
            [req.staff.id]
        );
        res.json({ success: true, data: rows });
    } catch (e) { console.error('[tenants/mine]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/tenants
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('tenants') });
        }
        const { rows } = await db.query('SELECT * FROM tenants ORDER BY name');
        res.json({ success: true, data: rows });
    } catch (e) { console.error('[tenants]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

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
    } catch (e) { console.error('[tenants]', e.message); res.status(500).json({ error: 'Internal server error' }); }
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
    } catch (e) { console.error('[tenants]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
