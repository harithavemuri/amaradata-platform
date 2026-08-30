// @vitest-environment node
// owner-portal-tenant-client is monkey-patched on the real module (not
// vi.mock()'d) for the same reason tenant-modules-routes.test.js patches
// tenant-sso-client — server.js's own require() chain doesn't reliably see a
// vi.mock() factory nested inside another CJS require.
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const ownerPortalTenantClient = _require('../../backend/services/owner-portal-tenant-client.js');
const searchOwnersMock = vi.fn();
const linkOwnerMock    = vi.fn();
ownerPortalTenantClient.searchOwners = searchOwnersMock;
ownerPortalTenantClient.linkOwner    = linkOwnerMock;

import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('Owner Portal Links (property_owner cross-tenant identity)', () => {
    let tenantId;
    let ownerId;      // a property_owner account
    let staffId;      // a non-owner account, for the role-mismatch check

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('siteAdmin'))
            .send({ name: 'Owner Link Tenant', slug: `ownerlink-${uid()}`, status: 'active', site_url: 'https://rohas.example.com' });
        tenantId = t.body.data?.id;

        const o = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `owner-${uid()}@t.com`, name: 'Test Owner', role: 'property_owner' });
        ownerId = o.body.data?.id;

        const s = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `staff-${uid()}@t.com`, name: 'Test Staff', role: 'staff' });
        staffId = s.body.data?.id;
    });

    beforeEach(() => {
        searchOwnersMock.mockReset();
        linkOwnerMock.mockReset();
    });

    describe('POST /api/admin/users — owner_portal_uid auto-generation', () => {
        it('a property_owner account gets a UID immediately, no manual entry', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `owner2-${uid()}@t.com`, name: 'Owner Two', role: 'property_owner' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.owner_portal_uid).toBeTruthy();
        });

        it('a staff account gets no UID', async () => {
            const res = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `staff2-${uid()}@t.com`, name: 'Staff Two', role: 'staff' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.owner_portal_uid).toBeFalsy();
        });
    });

    describe('PUT /api/admin/users/:id — role changed to property_owner', () => {
        it('generates a UID when switching an existing staff account to property_owner', async () => {
            const s = await request(app).post('/api/admin/users')
                .set(auth('siteAdmin'))
                .send({ email: `staff-tobe-owner-${uid()}@t.com`, name: 'Soon Owner', role: 'staff' });
            const res = await request(app).put(`/api/admin/users/${s.body.data.id}`)
                .set(auth('siteAdmin'))
                .send({ role: 'property_owner' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.owner_portal_uid).toBeTruthy();
        });

        it('does not overwrite an existing UID on an unrelated update', async () => {
            const before = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            const ownerBefore = before.body.data.find(u => u.id === ownerId);

            const res = await request(app).put(`/api/admin/users/${ownerId}`)
                .set(auth('siteAdmin'))
                .send({ name: 'Test Owner Renamed' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.owner_portal_uid).toBe(ownerBefore.owner_portal_uid);
        });
    });

    describe('GET /api/tenants/:id/owner-candidates', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get(`/api/tenants/${tenantId}/owner-candidates?q=rajesh`);
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with admin (not super_admin) → 403', async () => {
            const res = await request(app).get(`/api/tenants/${tenantId}/owner-candidates?q=rajesh`).set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('q shorter than 2 characters → 400, no tenant call made', async () => {
            const res = await request(app).get(`/api/tenants/${tenantId}/owner-candidates?q=r`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(400);
            expect(searchOwnersMock).not.toHaveBeenCalled();
        });

        it('proxies to the tenant and returns candidate owner rows', async () => {
            searchOwnersMock.mockResolvedValueOnce([
                { id: 1, first_name: 'Rajesh', last_name: 'Kumar', email: 'rajesh.kumar@email.com', project_id: 1, project_name: 'Amaracasa' },
            ]);
            const res = await request(app).get(`/api/tenants/${tenantId}/owner-candidates?q=rajesh`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].email).toBe('rajesh.kumar@email.com');
            expect(searchOwnersMock).toHaveBeenCalledWith(expect.objectContaining({ id: tenantId }), 'rajesh');
        });

        it('tenant site unreachable → 502, not 500', async () => {
            searchOwnersMock.mockRejectedValueOnce(Object.assign(new Error('Tenant API call failed: fetch failed'), { tenantUnreachable: true }));
            const res = await request(app).get(`/api/tenants/${tenantId}/owner-candidates?q=rajesh`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(502);
            expect(res.body.error).toContain('Tenant site unavailable');
        });
    });

    describe('POST /api/admin/users/:id/owner-links', () => {
        it('missing required fields → 400', async () => {
            const res = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('non-property_owner user → 400, no tenant call made', async () => {
            const res = await request(app).post(`/api/admin/users/${staffId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 1 });
            assertJson(res);
            expect(res.status).toBe(400);
            expect(linkOwnerMock).not.toHaveBeenCalled();
        });

        it('links the owner, pushing this account\'s existing owner_portal_uid to the tenant', async () => {
            linkOwnerMock.mockResolvedValueOnce({ id: 1, owner_portal_identifier: 'whatever' });
            const res = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({
                    tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 1,
                    tenant_owner_email: 'rajesh.kumar@email.com', tenant_owner_name: 'Rajesh Kumar',
                });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.tenant_owner_email).toBe('rajesh.kumar@email.com');

            const ownerRes = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            const owner = ownerRes.body.data.find(u => u.id === ownerId);
            expect(linkOwnerMock).toHaveBeenCalledWith(
                expect.objectContaining({ id: tenantId }),
                { project_id: 1, owner_id: 1, identifier: owner.owner_portal_uid },
            );
        });

        it('re-linking the same (owner, tenant, project, tenant_owner) is idempotent (upsert, not duplicate)', async () => {
            linkOwnerMock.mockResolvedValue({ id: 1, owner_portal_identifier: 'whatever' });
            await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 1, tenant_owner_name: 'Rajesh V2' });
            const res = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 1, tenant_owner_name: 'Rajesh V3' });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.data.tenant_owner_name).toBe('Rajesh V3');

            const listRes = await request(app).get(`/api/admin/users/${ownerId}/owner-links`).set(auth('siteAdmin'));
            const matches = listRes.body.data.filter(l => l.tenant_id === tenantId && l.tenant_project_id === 1 && l.tenant_owner_id === 1);
            expect(matches).toHaveLength(1);
        });

        it('tenant rejects the identifier as a duplicate (409) → passed straight through, not masked as 502', async () => {
            linkOwnerMock.mockRejectedValueOnce(Object.assign(new Error('That identifier is already assigned to a different owner.'), { tenantStatus: 409 }));
            const res = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 2 });
            assertJson(res);
            expect(res.status).toBe(409);
        });

        it('tenant site unreachable → 502', async () => {
            linkOwnerMock.mockRejectedValueOnce(Object.assign(new Error('Tenant has no site_url configured'), { tenantUnreachable: true }));
            const res = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 3 });
            assertJson(res);
            expect(res.status).toBe(502);
        });
    });

    describe('GET /api/admin/users/:id/owner-links', () => {
        it('lists links for this owner, enriched with tenant_name', async () => {
            linkOwnerMock.mockResolvedValueOnce({ id: 1 });
            await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 1, tenant_owner_id: 9 });

            const res = await request(app).get(`/api/admin/users/${ownerId}/owner-links`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            const match = res.body.data.find(l => l.tenant_project_id === 1 && l.tenant_owner_id === 9);
            expect(match).toBeTruthy();
            expect(match.tenant_name).toBe('Owner Link Tenant');
        });
    });

    describe('DELETE /api/admin/users/:id/owner-links/:linkId', () => {
        it('removes the link record', async () => {
            linkOwnerMock.mockResolvedValueOnce({ id: 1 });
            const createRes = await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 5, tenant_owner_id: 5 });
            const linkId = createRes.body.data.id;

            const delRes = await request(app).delete(`/api/admin/users/${ownerId}/owner-links/${linkId}`).set(auth('siteAdmin'));
            assertJson(delRes);
            expect(delRes.status).toBe(200);

            const listRes = await request(app).get(`/api/admin/users/${ownerId}/owner-links`).set(auth('siteAdmin'));
            expect(listRes.body.data.find(l => l.id === linkId)).toBeUndefined();
        });

        it('unknown link id → 404', async () => {
            const res = await request(app).delete(`/api/admin/users/${ownerId}/owner-links/999999999`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/admin/users/:id/rotate-owner-uid', () => {
        it('non-property_owner user → 400', async () => {
            const res = await request(app).post(`/api/admin/users/${staffId}/rotate-owner-uid`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('changes the UID and re-pushes it to every linked tenant', async () => {
            linkOwnerMock.mockResolvedValue({ id: 1 });
            await request(app).post(`/api/admin/users/${ownerId}/owner-links`)
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, tenant_project_id: 7, tenant_owner_id: 7 });

            const before = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            const uidBefore = before.body.data.find(u => u.id === ownerId).owner_portal_uid;

            linkOwnerMock.mockClear();
            linkOwnerMock.mockResolvedValueOnce({ id: 1 });
            const res = await request(app).post(`/api/admin/users/${ownerId}/rotate-owner-uid`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.owner_portal_uid).not.toBe(uidBefore);
            expect(res.body.data.tenants.some(t => t.tenant_id === tenantId && t.success)).toBe(true);

            expect(linkOwnerMock).toHaveBeenCalledWith(
                expect.objectContaining({ tenant_id: tenantId, site_url: 'https://rohas.example.com' }),
                { project_id: 7, owner_id: 7, identifier: res.body.data.owner_portal_uid },
            );

            const after = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            expect(after.body.data.find(u => u.id === ownerId).owner_portal_uid).toBe(res.body.data.owner_portal_uid);
        });

        it('one unreachable tenant does not block the rotation — reported per-tenant instead', async () => {
            linkOwnerMock.mockRejectedValueOnce(Object.assign(new Error('Tenant API call failed: fetch failed'), { tenantUnreachable: true }));
            const res = await request(app).post(`/api/admin/users/${ownerId}/rotate-owner-uid`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.tenants.some(t => t.success === false)).toBe(true);
        });

        it('refuses to rotate a disabled owner account', async () => {
            await request(app).put(`/api/admin/users/${ownerId}`).set(auth('siteAdmin')).send({ is_active: false });
            const res = await request(app).post(`/api/admin/users/${ownerId}/rotate-owner-uid`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(400);
            await request(app).put(`/api/admin/users/${ownerId}`).set(auth('siteAdmin')).send({ is_active: true });
        });
    });
});
