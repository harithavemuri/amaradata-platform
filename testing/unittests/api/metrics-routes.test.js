// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Metrics API', () => {
    let tenantId;

    beforeAll(async () => {
        const res = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Metrics Tenant', slug: `met-${uid()}` });
        tenantId = res.body.data?.id;
    });

    // ── POST /api/metrics ─────────────────────────────────────────────────────
    describe('POST /api/metrics', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/metrics')
                .send({ tenant_id: 1, period_year: 2025, period_month: 1 });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('missing tenant_id → 400 with error', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ period_year: 2025, period_month: 1 });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing period_year → 400', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_month: 1 });
            expect(res.status).toBe(400);
        });

        it('missing period_month → 400', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025 });
            expect(res.status).toBe(400);
        });

        it('valid minimal → 201 with all numeric defaults at 0', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 6 });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.sales_count).toBe(0);
            expect(res.body.data.sales_value).toBe(0);
            expect(res.body.data.rental_units).toBe(0);
            expect(res.body.data.rental_income).toBe(0);
            expect(res.body.data.active_properties).toBe(0);
        });

        it('valid with all metric fields → 201 with correct values', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId, period_year: 2025, period_month: 7,
                    sales_count: 15, sales_value: 750000,
                    rental_units: 8, rental_income: 120000,
                    active_properties: 22,
                });
            expect(res.status).toBe(201);
            expect(res.body.data.sales_count).toBe(15);
            expect(res.body.data.sales_value).toBe(750000);
            expect(res.body.data.rental_units).toBe(8);
            expect(res.body.data.rental_income).toBe(120000);
            expect(res.body.data.active_properties).toBe(22);
        });

        it('upsert: second POST for same period overwrites values', async () => {
            await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 8, sales_count: 5 });

            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 8, sales_count: 10, rental_units: 3 });
            expect(res.status).toBe(201);
            expect(res.body.data.sales_count).toBe(10);
            expect(res.body.data.rental_units).toBe(3);
        });

        it('staff role is allowed to POST metrics', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 9 });
            expect(res.status).toBe(201);
        });

        it('admin role is allowed to POST metrics', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 10 });
            expect(res.status).toBe(201);
        });

        it('response includes collected_at timestamp', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 11 });
            expect(res.status).toBe(201);
            expect(res.body.data.collected_at).toBeTruthy();
        });
    });
});
