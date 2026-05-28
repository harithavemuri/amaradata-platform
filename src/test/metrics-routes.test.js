// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Metrics routes', () => {
    let tenantId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Metrics Tenant', slug: `met-t-${uid()}` });
        tenantId = t.body.data?.id;
    });

    describe('POST /api/metrics', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/metrics')
                .send({ tenant_id: 1, period_year: 2025, period_month: 1 });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('missing tenant_id → 400', async () => {
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

        it('valid → 201 with defaults for omitted numeric fields', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 1 });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({
                tenant_id:         tenantId,
                period_year:       2025,
                period_month:      1,
                sales_count:       0,
                sales_value:       0,
                rental_units:      0,
                rental_income:     0,
                active_properties: 0,
            });
        });

        it('valid with all fields → 201', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({
                    tenant_id:         tenantId,
                    period_year:       2025,
                    period_month:      2,
                    sales_count:       10,
                    sales_value:       500000,
                    rental_units:      5,
                    rental_income:     120000,
                    active_properties: 15,
                });
            expect(res.status).toBe(201);
            expect(res.body.data.sales_count).toBe(10);
            expect(res.body.data.sales_value).toBe(500000);
        });

        it('re-posting same period → upserts (201)', async () => {
            const body = { tenant_id: tenantId, period_year: 2025, period_month: 3, sales_count: 1, sales_value: 1000 };
            await request(app).post('/api/metrics').set(auth('staff')).send(body);

            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ ...body, sales_count: 5, sales_value: 9999 });
            expect(res.status).toBe(201);
            expect(res.body.data.sales_count).toBe(5);
            expect(res.body.data.sales_value).toBe(9999);
        });

        it('staff role is sufficient (not admin-only)', async () => {
            const res = await request(app).post('/api/metrics')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, period_year: 2025, period_month: 4 });
            expect(res.status).toBe(201);
        });
    });
});
