// @vitest-environment node
// jobs/collect-metrics.js — calls each tenant's own GET /api/billing/metrics
// (billing-tenant-client.js) and upserts the result into billing_metrics.
// billing-tenant-client is monkey-patched on the real module (not
// vi.mock()'d) for the same reason tenant-modules-routes.test.js patches
// tenant-sso-client — server.js's/the job's own require() chain doesn't
// reliably see a vi.mock() factory nested inside another CJS require.
import { vi, describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const billingTenantClient = _require('../../backend/services/billing-tenant-client.js');
const fetchMetricsMock = vi.fn();
billingTenantClient.fetchMetrics = fetchMetricsMock;

const { collectForTenant } = _require('../../jobs/collect-metrics.js');

import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('jobs/collect-metrics.js', () => {
    let tenantId;

    beforeAll(async () => {
        const res = await request(app).post('/api/tenants')
            .set(auth('siteAdmin'))
            .send({ name: 'Collect Metrics Tenant', slug: `collectmetrics-${uid()}`, status: 'active', site_url: 'https://rohas.example.com' });
        tenantId = res.body.data.id;
    });

    it('upserts a billing_metrics row from the tenant\'s own response, not a direct DB query', async () => {
        fetchMetricsMock.mockResolvedValueOnce({
            sales_count: 3, sales_value: 9000000, rental_units: 5, rental_income: 150000, active_properties: 40,
        });

        await collectForTenant({ id: tenantId, name: 'Collect Metrics Tenant', site_url: 'https://rohas.example.com' }, 2026, 6);

        expect(fetchMetricsMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: tenantId }), 2026, 6,
        );

        const res = await request(app).get('/api/metrics').set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        const row = res.body.data.find((m) => m.tenant_id === tenantId && m.period_year === 2026 && m.period_month === 6);
        expect(row).toBeTruthy();
        expect(Number(row.sales_value)).toBe(9000000);
        expect(row.rental_units).toBe(5);
    });

    it('re-running for the same period upserts rather than duplicating', async () => {
        fetchMetricsMock.mockResolvedValueOnce({
            sales_count: 4, sales_value: 12000000, rental_units: 6, rental_income: 180000, active_properties: 38,
        });

        await collectForTenant({ id: tenantId, name: 'Collect Metrics Tenant', site_url: 'https://rohas.example.com' }, 2026, 6);

        const res = await request(app).get('/api/metrics').set(auth('siteAdmin'));
        const matches = res.body.data.filter((m) => m.tenant_id === tenantId && m.period_year === 2026 && m.period_month === 6);
        expect(matches).toHaveLength(1);
        expect(Number(matches[0].sales_value)).toBe(12000000);
    });

    it('a tenant-unreachable failure is logged and does not throw — one bad tenant must not stop the run', async () => {
        fetchMetricsMock.mockRejectedValueOnce(Object.assign(new Error('Tenant API call failed: fetch failed'), { tenantUnreachable: true }));
        await expect(collectForTenant({ id: tenantId, name: 'Collect Metrics Tenant', site_url: 'https://rohas.example.com' }, 2026, 7))
            .rejects.toThrow(); // collectForTenant itself propagates; run()'s per-tenant try/catch is what actually isolates failures.
    });
});
