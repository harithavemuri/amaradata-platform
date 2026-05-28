// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Subscriptions routes', () => {
    let tenantId;
    let planId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Sub Tenant', slug: `sub-t-${uid()}` });
        tenantId = t.body.data?.id;

        const p = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `Plan ${uid()}`, description: 'Seed plan', sales_pct: 1.5, rental_pct: 2, currency_code: 'INR' });
        planId = p.body.data?.id;
    });

    // ── POST /api/subscriptions/plans ────────────────────────────────────────
    describe('POST /api/subscriptions/plans', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .send({ name: 'Plan A' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('staff'))
                .send({ name: 'Plan A' });
            expect(res.status).toBe(403);
        });

        it('missing name → 400', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ description: 'No name' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('valid → 201 with defaults for omitted numerics', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ name: `Growth ${uid()}` });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({
                sales_pct:       0,
                rental_pct:      0,
                hourly_rate:     0,
                min_monthly_fee: 0,
                currency_code:   'INR',
                is_active:       true,
            });
        });

        it('valid with all fields → 201', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({
                    name:            `Premium ${uid()}`,
                    description:     'Full service',
                    sales_pct:       2.5,
                    rental_pct:      3.0,
                    hourly_rate:     1500,
                    min_monthly_fee: 10000,
                    currency_code:   'USD',
                });
            expect(res.status).toBe(201);
            expect(res.body.data.hourly_rate).toBe(1500);
            expect(res.body.data.currency_code).toBe('USD');
        });
    });

    // ── POST /api/subscriptions ──────────────────────────────────────────────
    describe('POST /api/subscriptions', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/subscriptions')
                .send({ tenant_id: 1, plan_id: 1, effective_from: '2025-01-01' });
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2025-01-01' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ plan_id: planId, effective_from: '2025-01-01' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing plan_id → 400', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, effective_from: '2025-01-01' });
            expect(res.status).toBe(400);
        });

        it('missing effective_from → 400', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, plan_id: planId });
            expect(res.status).toBe(400);
        });

        it('valid → 201', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2025-01-01' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({ tenant_id: tenantId, plan_id: planId });
        });

        it('second subscription closes previous (effective_to set)', async () => {
            const t2 = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'Sub2', slug: `sub2-${uid()}` });
            const tid = t2.body.data.id;

            await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tid, plan_id: planId, effective_from: '2025-01-01' });

            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tid, plan_id: planId, effective_from: '2025-06-01' });
            expect(res.status).toBe(201);
            expect(res.body.data.effective_to).toBeNull();
        });
    });
});
