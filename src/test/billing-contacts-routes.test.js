// @vitest-environment node
// /api/billing-contacts — flexible billing contact routing: a single
// contact can be scoped to a whole tenant, one project within a tenant, one
// property within a project, or several scopes across DIFFERENT tenants at
// once (cross-tenant). tenants.contact_name/email/phone/billing_address
// remain the fallback when no scope row matches. See
// project-billing-contact-routing.md.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('/api/billing-contacts', () => {
    let tenantAId, tenantBId;

    beforeAll(async () => {
        const a = await request(app).post('/api/tenants').set(auth('admin')).send({ name: 'BC Tenant A', slug: `bc-a-${uid()}` });
        tenantAId = a.body.data.id;
        const b = await request(app).post('/api/tenants').set(auth('admin')).send({ name: 'BC Tenant B', slug: `bc-b-${uid()}` });
        tenantBId = b.body.data.id;
    });

    describe('POST /api/billing-contacts', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/billing-contacts').send({ name: 'X', email: 'x@x.com' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff (not admin) → 403', async () => {
            const res = await request(app).post('/api/billing-contacts').set(auth('staff')).send({ name: 'X', email: 'x@x.com' });
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('missing email → 400', async () => {
            const res = await request(app).post('/api/billing-contacts').set(auth('admin')).send({ name: 'No Email' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('creates a contact with no scopes yet', async () => {
            const res = await request(app).post('/api/billing-contacts').set(auth('admin'))
                .send({ name: 'Jane Owner', email: `jane-${uid()}@x.com`, phone: '+91-9000000000' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.name).toBe('Jane Owner');
        });
    });

    describe('scope CRUD and cross-tenant assignment', () => {
        let contactId;

        beforeAll(async () => {
            const res = await request(app).post('/api/billing-contacts').set(auth('admin'))
                .send({ name: 'Cross Tenant Owner', email: `cross-${uid()}@x.com` });
            contactId = res.body.data.id;
        });

        it('adds a tenant-level scope', async () => {
            const res = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'tenant' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.scope_type).toBe('tenant');
        });

        it('adds a project-level scope on a DIFFERENT tenant — cross-tenant works', async () => {
            const res = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantBId, scope_type: 'project', tenant_project_id: 7 });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.tenant_id).toBe(tenantBId);
        });

        it('adds a property-level scope', async () => {
            const res = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantBId, scope_type: 'property', tenant_project_id: 7, tenant_property_id: 42 });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.tenant_property_id).toBe(42);
        });

        it('project scope missing tenant_project_id → 400', async () => {
            const res = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'project' });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('property scope missing tenant_property_id → 400', async () => {
            const res = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'property', tenant_project_id: 1 });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('GET /api/billing-contacts/:id returns the contact with all its scopes, enriched with tenant_name', async () => {
            const res = await request(app).get(`/api/billing-contacts/${contactId}`).set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.scopes).toHaveLength(3);
            const tenantScope = res.body.data.scopes.find(s => s.scope_type === 'tenant');
            expect(tenantScope.tenant_name).toBe('BC Tenant A');
        });

        it('a second contact cannot claim the exact same scope (tenant-level) as an existing one → 409', async () => {
            const other = await request(app).post('/api/billing-contacts').set(auth('admin'))
                .send({ name: 'Duplicate Claimant', email: `dup-${uid()}@x.com` });
            const res = await request(app).post(`/api/billing-contacts/${other.body.data.id}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'tenant' });
            assertJson(res);
            expect(res.status).toBe(409);
        });

        it('DELETE a scope removes just that mapping', async () => {
            const add = await request(app).post(`/api/billing-contacts/${contactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'project', tenant_project_id: 99 });
            const scopeId = add.body.data.id;

            const del = await request(app).delete(`/api/billing-contacts/scopes/${scopeId}`).set(auth('admin'));
            assertJson(del);
            expect(del.status).toBe(200);

            const check = await request(app).get(`/api/billing-contacts/${contactId}`).set(auth('admin'));
            expect(check.body.data.scopes.find(s => s.id === scopeId)).toBeUndefined();
        });
    });

    describe('GET /api/billing-contacts/resolve', () => {
        let propertyContactId, projectContactId, tenantContactId, resolveTenantId;
        const tenantProjectId = 501, tenantPropertyId = 9001;

        beforeAll(async () => {
            // Dedicated tenant for this block — reusing tenantAId (already
            // claimed at tenant-level by the "scope CRUD" describe block
            // above) would silently collide on the unique-scope constraint.
            const rt = await request(app).post('/api/tenants').set(auth('admin')).send({ name: 'BC Resolve Tenant', slug: `bc-resolve-${uid()}` });
            resolveTenantId = rt.body.data.id;

            const t = await request(app).post('/api/billing-contacts').set(auth('admin')).send({ name: 'Tenant-Level Contact', email: `t-${uid()}@x.com` });
            tenantContactId = t.body.data.id;
            await request(app).post(`/api/billing-contacts/${tenantContactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: resolveTenantId, scope_type: 'tenant' });

            const p = await request(app).post('/api/billing-contacts').set(auth('admin')).send({ name: 'Project-Level Contact', email: `p-${uid()}@x.com` });
            projectContactId = p.body.data.id;
            await request(app).post(`/api/billing-contacts/${projectContactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: resolveTenantId, scope_type: 'project', tenant_project_id: tenantProjectId });

            const pr = await request(app).post('/api/billing-contacts').set(auth('admin')).send({ name: 'Property-Level Contact', email: `pr-${uid()}@x.com` });
            propertyContactId = pr.body.data.id;
            await request(app).post(`/api/billing-contacts/${propertyContactId}/scopes`).set(auth('admin'))
                .send({ tenant_id: resolveTenantId, scope_type: 'property', tenant_project_id: tenantProjectId, tenant_property_id: tenantPropertyId });
        });

        it('most specific match wins: property-level beats project-level beats tenant-level', async () => {
            const res = await request(app)
                .get(`/api/billing-contacts/resolve?tenant_id=${resolveTenantId}&tenant_project_id=${tenantProjectId}&tenant_property_id=${tenantPropertyId}`)
                .set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.billing_contact_id).toBe(propertyContactId);
            expect(res.body.data.matched_scope).toBe('property');
        });

        it('a different property in the same project falls back to the project-level contact', async () => {
            const res = await request(app)
                .get(`/api/billing-contacts/resolve?tenant_id=${resolveTenantId}&tenant_project_id=${tenantProjectId}&tenant_property_id=99999`)
                .set(auth('admin'));
            assertJson(res);
            expect(res.body.data.billing_contact_id).toBe(projectContactId);
            expect(res.body.data.matched_scope).toBe('project');
        });

        it('a different project falls back to the tenant-level contact', async () => {
            const res = await request(app)
                .get(`/api/billing-contacts/resolve?tenant_id=${resolveTenantId}&tenant_project_id=88888`)
                .set(auth('admin'));
            assertJson(res);
            expect(res.body.data.billing_contact_id).toBe(tenantContactId);
            expect(res.body.data.matched_scope).toBe('tenant');
        });

        it('no matching billing_contact at all falls back to the tenant\'s own contact_name/email columns', async () => {
            await request(app).put(`/api/tenants/${tenantBId}`).set(auth('admin'))
                .send({ contact_name: 'Fallback Person', contact_email: 'fallback@x.com' });
            const res = await request(app)
                .get(`/api/billing-contacts/resolve?tenant_id=${tenantBId}&tenant_project_id=1&tenant_property_id=1`)
                .set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.matched_scope).toBe('tenant_default');
            expect(res.body.data.name).toBe('Fallback Person');
            expect(res.body.data.email).toBe('fallback@x.com');
        });

        it('missing tenant_id → 400', async () => {
            const res = await request(app).get('/api/billing-contacts/resolve').set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/billing-contacts', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/billing-contacts');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('lists all contacts (any authenticated staff can view)', async () => {
            const res = await request(app).get('/api/billing-contacts').set(auth('staff'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
            expect(res.body.data.length).toBeGreaterThan(0);
        });
    });

    describe('PUT /api/billing-contacts/:id', () => {
        it('updates contact fields', async () => {
            const create = await request(app).post('/api/billing-contacts').set(auth('admin'))
                .send({ name: 'Original Name', email: `orig-${uid()}@x.com` });
            const res = await request(app).put(`/api/billing-contacts/${create.body.data.id}`).set(auth('admin'))
                .send({ name: 'Updated Name', phone: '+91-1234567890' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Updated Name');
            expect(res.body.data.phone).toBe('+91-1234567890');
        });
    });

    describe('DELETE /api/billing-contacts/:id', () => {
        it('deletes the contact and cascades its scopes', async () => {
            const create = await request(app).post('/api/billing-contacts').set(auth('admin'))
                .send({ name: 'To Delete', email: `del-${uid()}@x.com` });
            const cid = create.body.data.id;
            await request(app).post(`/api/billing-contacts/${cid}/scopes`).set(auth('admin'))
                .send({ tenant_id: tenantAId, scope_type: 'project', tenant_project_id: 12345 });

            const del = await request(app).delete(`/api/billing-contacts/${cid}`).set(auth('admin'));
            assertJson(del);
            expect(del.status).toBe(200);

            const check = await request(app).get(`/api/billing-contacts/${cid}`).set(auth('admin'));
            expect(check.status).toBe(404);
        });
    });
});
