/**
 * Flexible billing contact routing — a single billing_contacts row can be
 * scoped (via billing_contact_scopes) to a whole tenant, one project within
 * a tenant, one property within a project, or several scopes across
 * DIFFERENT tenants at once (a cross-tenant contact — e.g. an owner who
 * holds properties in two tenants and wants one consolidated point of
 * contact). tenant_project_id/tenant_property_id are the tenant's OWN
 * internal ids — opaque to AmaraData, same convention as
 * owner_tenant_links.tenant_project_id/tenant_owner_id, since AmaraData has
 * no projects/properties table of its own.
 *
 * tenants.contact_name/email/phone/billing_address remain untouched as the
 * fallback when GET /resolve finds no scope row at all for a tenant — this
 * is additive, not a replacement, so nothing that already reads those
 * columns needs to change.
 *
 * See project-billing-contact-routing.md.
 */
const router = require('express').Router();
const db     = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { sendError } = require('../services/http-errors');
const { blockNonDbWrite } = require('../middleware/block-nondb-write');

function validateScopeShape(scope_type, tenant_project_id, tenant_property_id) {
    if (!['tenant', 'project', 'property'].includes(scope_type)) {
        return 'scope_type must be one of: tenant, project, property';
    }
    if (scope_type === 'tenant' && (tenant_project_id != null || tenant_property_id != null)) {
        return 'tenant-level scopes must not set tenant_project_id or tenant_property_id';
    }
    if (scope_type === 'project' && tenant_project_id == null) {
        return 'project-level scopes require tenant_project_id';
    }
    if (scope_type === 'property' && (tenant_project_id == null || tenant_property_id == null)) {
        return 'property-level scopes require both tenant_project_id and tenant_property_id';
    }
    return null;
}

// GET /api/billing-contacts — any authenticated staff can view (same trust
// level as viewing invoices/metrics lists).
router.get('/', async (req, res) => {
    try {
        if (req.db.mode === 'nondb') {
            return res.json({ success: true, data: req.db.fileDb.find('billing_contacts') });
        }
        const { rows } = await db.query('SELECT * FROM billing_contacts ORDER BY name');
        res.json({ success: true, data: rows });
    } catch (e) { sendError(res, e, '[billing-contacts]'); }
});

// GET /api/billing-contacts/resolve?tenant_id=&tenant_project_id=&tenant_property_id=
// Finds the most specific billing contact for a scope: property > project >
// tenant > the tenant's own contact_name/email/phone/billing_address as a
// last-resort default. Mounted BEFORE /:id so Express doesn't try to parse
// "resolve" as a numeric id.
router.get('/resolve', async (req, res) => {
    const tenant_id          = parseInt(req.query.tenant_id, 10);
    const tenant_project_id  = req.query.tenant_project_id  != null ? parseInt(req.query.tenant_project_id, 10)  : null;
    const tenant_property_id = req.query.tenant_property_id != null ? parseInt(req.query.tenant_property_id, 10) : null;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

    try {
        let scopes, tenant;
        if (req.db.mode === 'nondb') {
            scopes = req.db.fileDb.find('billing_contact_scopes').filter((s) => s.tenant_id == tenant_id);
            tenant = req.db.fileDb.getById('tenants', tenant_id);
        } else {
            const { rows: scopeRows } = await db.query('SELECT * FROM billing_contact_scopes WHERE tenant_id = $1', [tenant_id]);
            scopes = scopeRows;
            const { rows: tenantRows } = await db.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
            tenant = tenantRows[0];
        }

        const propertyMatch = tenant_property_id != null
            ? scopes.find((s) => s.scope_type === 'property' && s.tenant_project_id == tenant_project_id && s.tenant_property_id == tenant_property_id)
            : null;
        const projectMatch = !propertyMatch && tenant_project_id != null
            ? scopes.find((s) => s.scope_type === 'project' && s.tenant_project_id == tenant_project_id)
            : null;
        const tenantMatch = !propertyMatch && !projectMatch
            ? scopes.find((s) => s.scope_type === 'tenant')
            : null;
        const match = propertyMatch || projectMatch || tenantMatch;

        if (match) {
            let contact;
            if (req.db.mode === 'nondb') {
                contact = req.db.fileDb.getById('billing_contacts', match.billing_contact_id);
            } else {
                const { rows } = await db.query('SELECT * FROM billing_contacts WHERE id = $1', [match.billing_contact_id]);
                contact = rows[0];
            }
            return res.json({
                success: true,
                data: { billing_contact_id: contact.id, name: contact.name, email: contact.email, phone: contact.phone, billing_address: contact.billing_address, matched_scope: match.scope_type },
            });
        }

        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        res.json({
            success: true,
            data: { billing_contact_id: null, name: tenant.contact_name, email: tenant.contact_email, phone: tenant.contact_phone, billing_address: tenant.billing_address, matched_scope: 'tenant_default' },
        });
    } catch (e) { sendError(res, e, '[billing-contacts/resolve]'); }
});

// GET /api/billing-contacts/:id — contact + all its scopes, enriched with tenant_name.
router.get('/:id', async (req, res) => {
    try {
        let contact, scopes, tenants;
        if (req.db.mode === 'nondb') {
            contact = req.db.fileDb.getById('billing_contacts', req.params.id);
            if (!contact) return res.status(404).json({ error: 'Not found' });
            scopes = req.db.fileDb.find('billing_contact_scopes').filter((s) => s.billing_contact_id == req.params.id);
            tenants = req.db.fileDb.find('tenants');
        } else {
            const { rows: contactRows } = await db.query('SELECT * FROM billing_contacts WHERE id = $1', [req.params.id]);
            contact = contactRows[0];
            if (!contact) return res.status(404).json({ error: 'Not found' });
            const { rows: scopeRows } = await db.query('SELECT * FROM billing_contact_scopes WHERE billing_contact_id = $1 ORDER BY id', [req.params.id]);
            scopes = scopeRows;
            const { rows: tenantRows } = await db.query('SELECT id, name FROM tenants');
            tenants = tenantRows;
        }
        const tenantNames = Object.fromEntries(tenants.map((t) => [t.id, t.name]));
        const enrichedScopes = scopes.map((s) => ({ ...s, tenant_name: tenantNames[s.tenant_id] || null }));
        res.json({ success: true, data: { ...contact, scopes: enrichedScopes } });
    } catch (e) { sendError(res, e, '[billing-contacts]'); }
});

// POST /api/billing-contacts
router.post('/', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { name, email, phone, billing_address, gstin, pan, notes } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
    try {
        const { rows } = await db.query(
            `INSERT INTO billing_contacts (name, email, phone, billing_address, gstin, pan, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, email, phone || null, billing_address || null, gstin || null, pan || null, notes || null],
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[billing-contacts]'); }
});

// PUT /api/billing-contacts/:id
router.put('/:id', requireAdmin, blockNonDbWrite, async (req, res) => {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.scopes;
    try {
        updates.updated_at = new Date().toISOString();
        const keys = Object.keys(updates);
        const vals = Object.values(updates);
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const { rows } = await db.query(
            `UPDATE billing_contacts SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
            [...vals, req.params.id],
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (e) { sendError(res, e, '[billing-contacts]'); }
});

// DELETE /api/billing-contacts/:id — cascades its scopes.
router.delete('/:id', requireAdmin, blockNonDbWrite, async (req, res) => {
    try {
        const { rows } = await db.query('DELETE FROM billing_contacts WHERE id = $1 RETURNING *', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[billing-contacts]'); }
});

// POST /api/billing-contacts/:id/scopes  { tenant_id, scope_type, tenant_project_id?, tenant_property_id? }
router.post('/:id/scopes', requireAdmin, blockNonDbWrite, async (req, res) => {
    const { tenant_id, scope_type, tenant_project_id, tenant_property_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const shapeError = validateScopeShape(scope_type, tenant_project_id, tenant_property_id);
    if (shapeError) return res.status(400).json({ error: shapeError });
    try {
        const { rows: contactRows } = await db.query('SELECT id FROM billing_contacts WHERE id = $1', [req.params.id]);
        if (!contactRows[0]) return res.status(404).json({ error: 'Billing contact not found' });

        const { rows } = await db.query(
            `INSERT INTO billing_contact_scopes (billing_contact_id, tenant_id, scope_type, tenant_project_id, tenant_property_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [req.params.id, tenant_id, scope_type, tenant_project_id ?? null, tenant_property_id ?? null],
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Another billing contact is already assigned to this exact scope.' });
        sendError(res, e, '[billing-contacts/scopes]');
    }
});

// DELETE /api/billing-contacts/scopes/:scopeId — removes one scope mapping
// without deleting the contact itself. Mounted at the router's top level
// (not nested under /:id) since a scope id alone is enough to find and
// delete the row.
router.delete('/scopes/:scopeId', requireAdmin, blockNonDbWrite, async (req, res) => {
    try {
        const { rows } = await db.query('DELETE FROM billing_contact_scopes WHERE id = $1 RETURNING *', [req.params.scopeId]);
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { sendError(res, e, '[billing-contacts/scopes]'); }
});

module.exports = router;
