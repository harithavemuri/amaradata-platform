// @vitest-environment node
// GET /api/tenants/:id/billing-properties — proxies to the tenant's own
// GET /api/billing/properties using that tenant's dedicated billing API key
// (billing-tenant-client.js), NOT the SSO staff-impersonation flow the
// /modules routes use, and NOT the owner-portal key either — least-privilege,
// same reasoning as /owner-candidates. Powers billing-contacts.html's
// property picker for property-level billing scopes.
//
// billing-tenant-client is monkey-patched on the real module (not vi.mock()'d)
// for the same reason owner-links-routes.test.js patches
// owner-portal-tenant-client — server.js's own require() chain doesn't
// reliably see a vi.mock() factory nested inside another CJS require.
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const billingTenantClient = _require('../../backend/services/billing-tenant-client.js');
const fetchPropertiesMock = vi.fn();
billingTenantClient.fetchProperties = fetchPropertiesMock;

import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('GET /api/tenants/:id/billing-properties', () => {
    let tenantId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('siteAdmin'))
            .send({ name: 'Billing Properties Tenant', slug: `billing-props-${uid()}`, status: 'active', site_url: 'https://rohas.example.com' });
        tenantId = t.body.data?.id;
    });

    beforeEach(() => {
        fetchPropertiesMock.mockReset();
    });

    it('without auth → 401', async () => {
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?project_id=1`);
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('with admin (not super_admin) → 403', async () => {
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?project_id=1`).set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(403);
    });

    it('neither project_id nor a 2+ character q → 400, no tenant call made', async () => {
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties`).set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(400);
        expect(fetchPropertiesMock).not.toHaveBeenCalled();
    });

    it('q shorter than 2 characters with no project_id → 400, no tenant call made', async () => {
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?q=r`).set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(400);
        expect(fetchPropertiesMock).not.toHaveBeenCalled();
    });

    it('proxies to the tenant and returns candidate property rows, scoped by project_id', async () => {
        fetchPropertiesMock.mockResolvedValueOnce([
            { id: 6, property_code: 'RP-AMR-201', property_name: 'Amaracasa Flat 201', city: 'Hyderabad', status: 'vacant', project_id: 1, project_name: 'Amaracasa' },
        ]);
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?project_id=1`).set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].property_code).toBe('RP-AMR-201');
        expect(fetchPropertiesMock).toHaveBeenCalledWith(expect.objectContaining({ id: tenantId }), { project_id: '1', q: undefined });
    });

    it('proxies a free-text search with no project_id', async () => {
        fetchPropertiesMock.mockResolvedValueOnce([
            { id: 6, property_code: 'RP-AMR-201', property_name: 'Amaracasa Flat 201', city: 'Hyderabad', status: 'vacant', project_id: 1, project_name: 'Amaracasa' },
        ]);
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?q=RP-AMR`).set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        expect(fetchPropertiesMock).toHaveBeenCalledWith(expect.objectContaining({ id: tenantId }), { project_id: undefined, q: 'RP-AMR' });
    });

    it('tenant site unreachable → 502, not 500', async () => {
        fetchPropertiesMock.mockRejectedValueOnce(Object.assign(new Error('Tenant API call failed: fetch failed'), { tenantUnreachable: true }));
        const res = await request(app).get(`/api/tenants/${tenantId}/billing-properties?project_id=1`).set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(502);
        expect(res.body.error).toContain('Tenant site unavailable');
    });

    it('unknown tenant id → 404, no tenant call made', async () => {
        const res = await request(app).get('/api/tenants/999999/billing-properties?project_id=1').set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(404);
        expect(fetchPropertiesMock).not.toHaveBeenCalled();
    });
});
