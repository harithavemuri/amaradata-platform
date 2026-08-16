// @vitest-environment node
// callTenantApi is monkey-patched on the real service module rather than
// vi.mock()'d — server.js's own require() chain doesn't reliably see a
// vi.mock() factory for a module nested inside another CJS require (same
// gotcha as backend/services/email-s3-client.js, see email-routes.test.js).
// createRequire(import.meta.url) reaches the exact object instance
// backend/routes/tenants.js's own require() sees.
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const tenantSsoClient = _require('../../backend/services/tenant-sso-client.js');
const callTenantApiMock = vi.fn();
tenantSsoClient.callTenantApi = callTenantApiMock;

import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('Tenant modules routes (SSO proxy)', () => {
    let tenantId;      // has a site_url — reachable
    let noSiteTenantId; // no site_url — should 502 before ever calling out

    beforeAll(async () => {
        const withSite = await request(app).post('/api/tenants')
            .set(auth('siteAdmin'))
            .send({ name: 'Modules Tenant', slug: `modtenant-${uid()}`, status: 'active', site_url: 'https://rohas.example.com' });
        tenantId = withSite.body.data?.id;

        const withoutSite = await request(app).post('/api/tenants')
            .set(auth('siteAdmin'))
            .send({ name: 'No Site Tenant', slug: `nosite-${uid()}`, status: 'active' });
        noSiteTenantId = withoutSite.body.data?.id;
    });

    beforeEach(() => callTenantApiMock.mockReset());

    describe('GET /api/tenants/:id/modules', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get(`/api/tenants/${tenantId}/modules`);
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with admin (not super_admin) → 403', async () => {
            const res = await request(app).get(`/api/tenants/${tenantId}/modules`).set(auth('admin'));
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('unknown tenant id → 404', async () => {
            const res = await request(app).get('/api/tenants/999999999/modules').set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(404);
        });

        it('proxies to the tenant site and returns its module rows', async () => {
            callTenantApiMock.mockResolvedValueOnce({
                success: true,
                data: [
                    { project_id: 1, project_name: 'Sunrise Towers', module: 'sales_management', enabled: true },
                    { project_id: 1, project_name: 'Sunrise Towers', module: 'rental_management', enabled: false },
                ],
            });
            const res = await request(app).get(`/api/tenants/${tenantId}/modules`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(2);

            // Called unscoped (no project_id) — AmaraData doesn't track rohas's
            // internal project ids, so it fetches everything for the tenant site.
            expect(callTenantApiMock).toHaveBeenCalledWith(
                expect.objectContaining({ id: tenantId, site_url: 'https://rohas.example.com' }),
                expect.objectContaining({ role: 'super_admin' }),
                { method: 'GET', path: '/api/admin/project-modules' }
            );
        });

        it('tenant with no site_url → 502 without calling the SSO client', async () => {
            callTenantApiMock.mockRejectedValueOnce(Object.assign(new Error('Tenant has no site_url configured'), { tenantUnreachable: true }));
            const res = await request(app).get(`/api/tenants/${noSiteTenantId}/modules`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(502);
            expect(res.body.error).toContain('Tenant site unavailable');
        });

        it('tenant site unreachable → 502, not 500', async () => {
            callTenantApiMock.mockRejectedValueOnce(Object.assign(new Error('SSO redemption failed: fetch failed'), { tenantUnreachable: true }));
            const res = await request(app).get(`/api/tenants/${tenantId}/modules`).set(auth('siteAdmin'));
            assertJson(res);
            expect(res.status).toBe(502);
            expect(res.body.error).toContain('Tenant site unavailable');
        });
    });

    describe('PUT /api/tenants/:id/modules', () => {
        it('without auth → 401', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}/modules`)
                .send({ project_id: 1, module: 'sales_management', enabled: true });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('missing required fields → 400', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}/modules`)
                .set(auth('siteAdmin'))
                .send({ project_id: 1 });
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('proxies the toggle through to the tenant site', async () => {
            callTenantApiMock.mockResolvedValueOnce({
                success: true,
                data: { id: 5, project_id: 1, module: 'sales_management', enabled: false },
            });
            const res = await request(app).put(`/api/tenants/${tenantId}/modules`)
                .set(auth('siteAdmin'))
                .send({ project_id: 1, module: 'sales_management', enabled: false });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.data.enabled).toBe(false);
            expect(callTenantApiMock).toHaveBeenCalledWith(
                expect.objectContaining({ id: tenantId }),
                expect.objectContaining({ role: 'super_admin' }),
                { method: 'PUT', path: '/api/admin/project-modules', body: { project_id: 1, module: 'sales_management', enabled: false } }
            );
        });
    });
});
