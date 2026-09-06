// @vitest-environment node
/**
 * Unit tests for backend/services/tenant-health-client.js — checks a
 * tenant's own public GET /health (no API key needed, same public/no-auth
 * exemption AmaraData's own GET /health has) and never throws, so one down
 * tenant can't take out the whole System Health panel. Mirrors
 * jobs/collect-metrics.js's per-tenant try/catch contract, but the
 * catch-and-normalize happens inside checkTenantHealth itself rather than
 * at the caller, since every result (not just failures) needs to be
 * collected for display.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkTenantHealth, checkAllTenantsHealth } from '../../../backend/services/tenant-health-client.js';

const TENANT = { id: 1, name: 'Rohas Group', slug: 'rohas', site_url: 'https://rohas.example.com' };

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('tenant-health-client checkTenantHealth', () => {
    it('returns reachable:true with the remote health payload on a 200', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            jsonResponse(200, { status: 'OK', mode: 'db', api_version: '1.2.3', ui_version: '1.2.3', db_version: '2026.01.01.001' })
        );

        const result = await checkTenantHealth(TENANT, { fetchImpl: fetchMock });

        expect(result.reachable).toBe(true);
        expect(result.status_code).toBe(200);
        expect(result.tenant_id).toBe(1);
        expect(result.slug).toBe('rohas');
        expect(result.remote).toEqual({ status: 'OK', mode: 'db', api_version: '1.2.3', ui_version: '1.2.3', db_version: '2026.01.01.001' });
        expect(result.error).toBeNull();
        expect(typeof result.latency_ms).toBe('number');
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
        expect(fetchMock).toHaveBeenCalledWith('https://rohas.example.com/health', expect.any(Object));
    });

    it('strips a trailing slash from site_url before appending /health', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { status: 'OK' }));
        await checkTenantHealth({ ...TENANT, site_url: 'https://rohas.example.com/' }, { fetchImpl: fetchMock });
        expect(fetchMock).toHaveBeenCalledWith('https://rohas.example.com/health', expect.any(Object));
    });

    it('returns reachable:false with a clear error when the tenant has no site_url — never calls fetch', async () => {
        const fetchMock = vi.fn();
        const result = await checkTenantHealth({ id: 2, name: 'No Site', slug: 'no-site' }, { fetchImpl: fetchMock });

        expect(result.reachable).toBe(false);
        expect(result.error).toMatch(/no site_url/i);
        expect(result.status_code).toBeNull();
        expect(result.latency_ms).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns reachable:false when the tenant responds with a non-2xx', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error' }));
        const result = await checkTenantHealth(TENANT, { fetchImpl: fetchMock });

        expect(result.reachable).toBe(false);
        expect(result.status_code).toBe(500);
        expect(result.error).toMatch(/500/);
    });

    it('returns reachable:false on a network failure — never throws', async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const result = await checkTenantHealth(TENANT, { fetchImpl: fetchMock });

        expect(result.reachable).toBe(false);
        expect(result.error).toMatch(/ECONNREFUSED/);
        expect(result.remote).toBeNull();
    });

    it('returns reachable:false with a timeout-flavored error when the request is aborted', async () => {
        const fetchMock = vi.fn().mockImplementationOnce(() => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        });
        const result = await checkTenantHealth(TENANT, { fetchImpl: fetchMock, timeoutMs: 50 });

        expect(result.reachable).toBe(false);
        expect(result.error).toMatch(/timed out/i);
    });

    it('tolerates a non-JSON response body without throwing', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
        const result = await checkTenantHealth(TENANT, { fetchImpl: fetchMock });

        expect(result.reachable).toBe(true);
        expect(result.remote).toBeNull();
    });
});

describe('tenant-health-client checkAllTenantsHealth', () => {
    it('checks every tenant in parallel and never rejects even when some are unreachable', async () => {
        const ok = { id: 1, name: 'Up', slug: 'up', site_url: 'https://up.example.com' };
        const down = { id: 2, name: 'Down', slug: 'down', site_url: 'https://down.example.com' };
        const noSite = { id: 3, name: 'NoSite', slug: 'no-site' };

        const fetchMock = vi.fn((url) => {
            if (url.startsWith('https://up.')) return Promise.resolve(jsonResponse(200, { status: 'OK' }));
            return Promise.reject(new Error('ECONNREFUSED'));
        });

        const results = await checkAllTenantsHealth([ok, down, noSite], { fetchImpl: fetchMock });

        expect(results).toHaveLength(3);
        expect(results.find(r => r.tenant_id === 1).reachable).toBe(true);
        expect(results.find(r => r.tenant_id === 2).reachable).toBe(false);
        expect(results.find(r => r.tenant_id === 3).reachable).toBe(false);
        expect(results.find(r => r.tenant_id === 3).error).toMatch(/no site_url/i);
    });
});
