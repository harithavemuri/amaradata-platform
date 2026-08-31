// @vitest-environment node
// POST /api/admin/billing/collect-metrics + GET /api/admin/billing/job-runs
// — the "Collect Metrics Now" button on frontend/metrics.html and its
// history view. jobs/collect-metrics.js's collectAllTenants is monkey-patched
// on the real module (not vi.mock()'d) for the same reason
// owner-links-routes.test.js patches owner-portal-tenant-client.js —
// server.js's/the route's own require() chain doesn't reliably see a
// vi.mock() factory nested inside another CJS require. The route requires
// jobs/collect-metrics lazily (inside the handler), but require() caching
// means it still resolves to this same patched module object.
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const collectMetricsJob = _require('../../jobs/collect-metrics.js');
const collectAllTenantsMock = vi.fn();
collectMetricsJob.collectAllTenants = collectAllTenantsMock;

import request from 'supertest';
import app from '../../server.js';
import { auth, assertJson } from './helpers.js';

describe('POST /api/admin/billing/collect-metrics', () => {
    beforeEach(() => collectAllTenantsMock.mockReset());

    it('without auth → 401', async () => {
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .send({ period_year: 2026, period_month: 8 });
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('with admin (not super_admin) → 403', async () => {
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('admin'))
            .send({ period_year: 2026, period_month: 8 });
        assertJson(res);
        expect(res.status).toBe(403);
    });

    it('missing period_month → 400, no job run created', async () => {
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026 });
        assertJson(res);
        expect(res.status).toBe(400);
        expect(collectAllTenantsMock).not.toHaveBeenCalled();
    });

    it('out-of-range period_month → 400', async () => {
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026, period_month: 13 });
        assertJson(res);
        expect(res.status).toBe(400);
    });

    it('all tenants succeed → status success, results persisted, triggered_by recorded', async () => {
        collectAllTenantsMock.mockResolvedValueOnce([
            { tenant_id: 1, tenant_name: 'Rohas Group', success: true, metrics: { sales_count: 2, sales_value: 500000, rental_units: 1, rental_income: 20000, active_properties: 80 } },
        ]);
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026, period_month: 8 });
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('success');
        expect(res.body.data.period_year).toBe(2026);
        expect(res.body.data.period_month).toBe(8);
        expect(res.body.data.results).toHaveLength(1);
        expect(res.body.data.results[0].tenant_name).toBe('Rohas Group');
        expect(res.body.data.triggered_by).toBe(902); // helpers.js's siteAdmin token id
        expect(res.body.data.completed_at).toBeTruthy();
    });

    it('every tenant fails → status failed', async () => {
        collectAllTenantsMock.mockResolvedValueOnce([
            { tenant_id: 1, tenant_name: 'Rohas Group', success: false, error: 'Tenant API call failed: fetch failed' },
        ]);
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026, period_month: 8 });
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('failed');
    });

    it('a mix of success/failure → status partial_failure', async () => {
        collectAllTenantsMock.mockResolvedValueOnce([
            { tenant_id: 1, tenant_name: 'Rohas Group', success: true, metrics: { sales_count: 0, sales_value: 0, rental_units: 0, rental_income: 0, active_properties: 5 } },
            { tenant_id: 2, tenant_name: 'Other Tenant', success: false, error: 'Tenant has no site_url configured' },
        ]);
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026, period_month: 8 });
        assertJson(res);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('partial_failure');
    });

    it('collectAllTenants throwing outright still marks the run failed, not left stuck at running', async () => {
        collectAllTenantsMock.mockRejectedValueOnce(new Error('platform DB unreachable'));
        const res = await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2026, period_month: 9 });
        assertJson(res);
        expect(res.status).toBe(500);

        const listRes = await request(app).get('/api/admin/billing/job-runs').set(auth('siteAdmin'));
        const row = listRes.body.data.find((r) => r.period_year === 2026 && r.period_month === 9);
        expect(row.status).toBe('failed');
    });
});

describe('GET /api/admin/billing/job-runs', () => {
    it('without auth → 401', async () => {
        const res = await request(app).get('/api/admin/billing/job-runs');
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('lists runs newest first, enriched with who triggered them', async () => {
        collectAllTenantsMock.mockResolvedValueOnce([
            { tenant_id: 1, tenant_name: 'Rohas Group', success: true, metrics: { sales_count: 1, sales_value: 1, rental_units: 0, rental_income: 0, active_properties: 1 } },
        ]);
        await request(app).post('/api/admin/billing/collect-metrics')
            .set(auth('siteAdmin'))
            .send({ period_year: 2027, period_month: 1 });

        const res = await request(app).get('/api/admin/billing/job-runs').set(auth('siteAdmin'));
        assertJson(res);
        expect(res.status).toBe(200);
        const row = res.body.data.find((r) => r.period_year === 2027 && r.period_month === 1);
        expect(row).toBeTruthy();
        expect(row.triggered_by_email).toBe('sadmin@t.com'); // helpers.js's siteAdmin token email
    });
});
