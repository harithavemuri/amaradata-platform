// @vitest-environment node
/**
 * Mocks global fetch to test the two-step SSO exchange (redeem redirect ->
 * parse sso_jwt -> call tenant API) without a real rohas-group server. See
 * project's tenant-sso-client design: backend/services/tenant-sso-client.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.SSO_SECRET = 'test-sso-secret-32-chars-minimum!!';

const { callTenantApi } = await import('../../../backend/services/tenant-sso-client.js');

const TENANT = { id: 1, slug: 'rohas', site_url: 'https://rohas.example.com' };
const STAFF  = { email: 'admin@amaradata.com', name: 'Admin', role: 'super_admin' };

function redirectResponse(location) {
    return { headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } };
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('tenant-sso-client callTenantApi', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('redeems the SSO token then calls the tenant API with the session JWT', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('https://rohas.example.com/dashboard?sso_jwt=tenant-session-jwt'))
            .mockResolvedValueOnce(jsonResponse(200, { success: true, data: [{ project_id: 1, module: 'sales_management', enabled: true }] }));

        const data = await callTenantApi(TENANT, STAFF, { method: 'GET', path: '/api/admin/project-modules' });

        expect(data.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Step 1: redemption call, manual redirect, token in query string
        const [redeemUrl, redeemOpts] = fetchMock.mock.calls[0];
        expect(redeemUrl).toContain('https://rohas.example.com/auth/sso?sso_token=');
        expect(redeemOpts.redirect).toBe('manual');
        // Step 2: real call carries the redeemed session JWT as Bearer auth
        const [apiUrl, apiOpts] = fetchMock.mock.calls[1];
        expect(apiUrl).toBe('https://rohas.example.com/api/admin/project-modules');
        expect(apiOpts.headers.Authorization).toBe('Bearer tenant-session-jwt');
    });

    it('sends a JSON body and Content-Type on PUT-style calls', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('https://rohas.example.com/dashboard?sso_jwt=tenant-session-jwt'))
            .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { project_id: 1, module: 'sales_management', enabled: false } }));

        await callTenantApi(TENANT, STAFF, {
            method: 'PUT', path: '/api/admin/project-modules',
            body: { project_id: 1, module: 'sales_management', enabled: false },
        });

        const [, apiOpts] = fetchMock.mock.calls[1];
        expect(apiOpts.method).toBe('PUT');
        expect(apiOpts.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(apiOpts.body)).toEqual({ project_id: 1, module: 'sales_management', enabled: false });
    });

    it('throws a tenantUnreachable error (not an uncaught exception) when SSO is not configured', async () => {
        // services/secrets.js's getSecret() throws outright when neither a
        // secretId nor a fallback env var is set at all — reproduced against a
        // real local dev server missing SSO_SECRET, which surfaced as a raw
        // uncaught 500 instead of the intended 502 until this was caught.
        const original = process.env.SSO_SECRET;
        delete process.env.SSO_SECRET;
        try {
            await expect(callTenantApi(TENANT, STAFF, { method: 'GET', path: '/x' }))
                .rejects.toMatchObject({ tenantUnreachable: true, message: 'SSO not configured' });
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            process.env.SSO_SECRET = original;
        }
    });

    it('throws a tenantUnreachable error when the tenant has no site_url', async () => {
        await expect(callTenantApi({ id: 2, slug: 'no-site' }, STAFF, { method: 'GET', path: '/x' }))
            .rejects.toMatchObject({ tenantUnreachable: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws a tenantUnreachable error when the redemption redirect has no sso_jwt', async () => {
        fetchMock.mockResolvedValueOnce(redirectResponse('https://rohas.example.com/login?error=bad_token'));
        await expect(callTenantApi(TENANT, STAFF, { method: 'GET', path: '/x' }))
            .rejects.toMatchObject({ tenantUnreachable: true });
    });

    it('throws a tenantUnreachable error when the redemption call returns no redirect at all', async () => {
        fetchMock.mockResolvedValueOnce({ headers: { get: () => null } });
        await expect(callTenantApi(TENANT, STAFF, { method: 'GET', path: '/x' }))
            .rejects.toMatchObject({ tenantUnreachable: true });
    });

    it('throws a tenantUnreachable error when the tenant API call itself fails (network error)', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('https://rohas.example.com/dashboard?sso_jwt=tenant-session-jwt'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(callTenantApi(TENANT, STAFF, { method: 'GET', path: '/x' }))
            .rejects.toMatchObject({ tenantUnreachable: true });
    });

    it('throws a tenantUnreachable error carrying the status when the tenant API returns a non-2xx', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectResponse('https://rohas.example.com/dashboard?sso_jwt=tenant-session-jwt'))
            .mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden' }));
        await expect(callTenantApi(TENANT, STAFF, { method: 'GET', path: '/x' }))
            .rejects.toMatchObject({ tenantUnreachable: true, status: 403 });
    });
});
