const router = require('express').Router();
const db     = require('../db');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');
// Not destructured: tests monkey-patch tenantSsoClient.callTenantApi directly
// (vi.mock() doesn't reliably intercept a require() nested inside server.js's
// own CJS require graph — see src/test/tenant-modules-routes.test.js and the
// identical email-s3-client.js gotcha), which only works through a live
// property read, not a copied local binding from destructuring at require time.
const tenantSsoClient = require('../services/tenant-sso-client');
// Same not-destructured reasoning as tenantSsoClient above — tests monkey-patch
// this module's exports directly.
const ownerPortalTenantClient = require('../services/owner-portal-tenant-client');
// Same not-destructured reasoning — tests monkey-patch this module's exports directly.
const billingTenantClient = require('../services/billing-tenant-client');

async function getTenant(req, id) {
    if (req.db.mode === 'nondb') {
        return req.db.fileDb.getById('tenants', id) || null;
    }
    const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return rows[0] || null;
}

// GET /api/tenants/mine — returns only tenants the current user is eligible to see
router.get('/mine', requireAuth, async (req, res) => {
    try {
        if (req.staff.role === 'super_admin') {
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
    } catch (e) { sendError(res, e, '[tenants/mine]'); }
});

// Plaintext DB and owner-portal credentials must never reach a caller here —
// GET /api/tenants only requires requireAuth (any staff role, not just
// admin/super_admin), so a SELECT * would leak tenant_db_password and
// owner_portal_api_key to every logged-in staff member regardless of role.
// requireAdmin-gated routes (POST/PUT below) return the full row on purpose
// — an admin setting these values needs to see what was actually saved.
const SENSITIVE_TENANT_FIELDS = new Set([
    'tenant_db_host', 'tenant_db_port', 'tenant_db_name', 'tenant_db_user',
    'tenant_db_secret_arn', 'tenant_db_password',
    'owner_portal_api_key_secret_arn', 'owner_portal_api_key',
]);

function sanitizeTenant(tenant) {
    return Object.fromEntries(Object.entries(tenant).filter(([key]) => !SENSITIVE_TENANT_FIELDS.has(key)));
}

// GET /api/tenants
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('tenants').map(sanitizeTenant) });
        }
        const { rows } = await db.query('SELECT * FROM tenants ORDER BY name');
        res.json({ success: true, data: rows.map(sanitizeTenant) });
    } catch (e) { sendError(res, e, '[tenants]'); }
});

// POST /api/tenants
router.post('/', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { name, slug, contact_name, contact_email, contact_phone, billing_address,
            gstin, pan, status, tenant_db_host, tenant_db_port, tenant_db_name,
            tenant_db_user, tenant_db_secret_arn, tenant_db_password, onboarded_at, notes, site_url } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    try {
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
    } catch (e) { sendError(res, e, '[tenants]'); }
});

// PUT /api/tenants/:id
router.put('/:id', requireAdmin, blockNonDbWrite, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    try {
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
    } catch (e) { sendError(res, e, '[tenants]'); }
});

// GET /api/tenants/:id/modules — proxies to the tenant site's own
// GET /api/admin/project-modules via SSO token exchange (see
// backend/services/tenant-sso-client.js). Called unscoped (no project_id) —
// AmaraData has no concept of the tenant's internal "projects", only the
// tenant site itself, so this returns every project+module row the tenant
// site knows about, each already carrying its own project_name for display.
router.get('/:id/modules', requireSuperAdmin, async (req, res) => {
    try {
        const tenant = await getTenant(req, req.params.id);
        if (!tenant) return res.status(404).json({ error: 'Not found' });
        const result = await tenantSsoClient.callTenantApi(tenant, req.staff, { method: 'GET', path: '/api/admin/project-modules' });
        res.json({ success: true, data: result.data || [] });
    } catch (e) {
        if (e.tenantUnreachable) return res.status(502).json({ error: `Tenant site unavailable: ${e.message}` });
        sendError(res, e, '[tenants/modules]');
    }
});

// PUT /api/tenants/:id/modules — { project_id, module, enabled }, proxies
// straight through to the tenant site's PUT /api/admin/project-modules
// (project_id is opaque here — it's whatever the GET above returned).
// Idempotent by construction: it's a passthrough to an already-idempotent
// upsert on the tenant side.
router.put('/:id/modules', requireSuperAdmin, blockNonDbWrite, async (req, res) => {
    const { project_id, module, enabled } = req.body || {};
    if (!project_id || !module || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'project_id, module, and enabled (boolean) are required' });
    }
    try {
        const tenant = await getTenant(req, req.params.id);
        if (!tenant) return res.status(404).json({ error: 'Not found' });
        const result = await tenantSsoClient.callTenantApi(tenant, req.staff, {
            method: 'PUT', path: '/api/admin/project-modules', body: { project_id, module, enabled },
        });
        res.json({ success: true, data: result.data });
    } catch (e) {
        if (e.tenantUnreachable) return res.status(502).json({ error: `Tenant site unavailable: ${e.message}` });
        sendError(res, e, '[tenants/modules]');
    }
});

// GET /api/tenants/:id/owner-candidates?q=<partial name/email> — proxies to
// the tenant's own GET /api/owner-portal/search-owners using that tenant's
// dedicated owner-portal API key (owner-portal-tenant-client.js), NOT the
// SSO staff-impersonation flow the /modules routes above use — this is
// server-to-server data access, not an action taken "as" a staff member.
// Powers the Owner Portal Links admin screen's tenant-owner lookup step.
router.get('/:id/owner-candidates', requireSuperAdmin, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'q query parameter (2+ characters) is required' });
    try {
        const tenant = await getTenant(req, req.params.id);
        if (!tenant) return res.status(404).json({ error: 'Not found' });
        const results = await ownerPortalTenantClient.searchOwners(tenant, q);
        res.json({ success: true, data: results });
    } catch (e) {
        if (e.tenantUnreachable) return res.status(502).json({ error: `Tenant site unavailable: ${e.message}` });
        if (e.tenantStatus) return res.status(e.tenantStatus).json({ error: e.message });
        sendError(res, e, '[tenants/owner-candidates]');
    }
});

// GET /api/tenants/:id/billing-properties?project_id=&q= — proxies to the
// tenant's own GET /api/billing/properties using that tenant's dedicated
// billing API key (billing-tenant-client.js) — NOT the SSO staff-
// impersonation flow the /modules routes use, and NOT owner-candidates'
// owner-portal key either (least-privilege, dedicated credential per
// integration). Powers billing-contacts.html's property picker for
// property-level billing scopes — see [[project-billing-contact-routing]].
router.get('/:id/billing-properties', requireSuperAdmin, async (req, res) => {
    const projectId = req.query.project_id;
    const q = req.query.q ? String(req.query.q).trim() : undefined;
    if (!projectId && (!q || q.length < 2)) {
        return res.status(400).json({ error: 'project_id or q (2+ characters) is required' });
    }
    try {
        const tenant = await getTenant(req, req.params.id);
        if (!tenant) return res.status(404).json({ error: 'Not found' });
        const results = await billingTenantClient.fetchProperties(tenant, { project_id: projectId, q });
        res.json({ success: true, data: results });
    } catch (e) {
        if (e.tenantUnreachable) return res.status(502).json({ error: `Tenant site unavailable: ${e.message}` });
        if (e.tenantStatus) return res.status(e.tenantStatus).json({ error: e.message });
        sendError(res, e, '[tenants/billing-properties]');
    }
});

module.exports = router;
