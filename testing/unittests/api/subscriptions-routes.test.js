// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Subscriptions API', () => {
    let tenantId;
    let planId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Sub Tenant', slug: `sub-${uid()}` });
        tenantId = t.body.data?.id;

        const p = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `BasePlan-${uid()}`, sales_pct: 2.5, rental_pct: 1.0, currency_code: 'INR' });
        planId = p.body.data?.id;
    });

    // ── POST /api/subscriptions/plans ─────────────────────────────────────────
    describe('POST /api/subscriptions/plans', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .send({ name: 'Basic' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('staff role → 403', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('staff'))
                .send({ name: 'Basic' });
            expect(res.status).toBe(403);
        });

        it('missing name → 400 with error', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ sales_pct: 2.0 });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('valid minimal → 201 with numeric defaults', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ name: `MinPlan-${uid()}` });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.sales_pct).toBe(0);
            expect(res.body.data.rental_pct).toBe(0);
            expect(res.body.data.hourly_rate).toBe(0);
            expect(res.body.data.min_monthly_fee).toBe(0);
            expect(res.body.data.currency_code).toBe('INR');
        });

        it('valid with all fields → 201 with correct values', async () => {
            const name = `GrowthPlan-${uid()}`;
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ name, sales_pct: 3.0, rental_pct: 1.5, hourly_rate: 1500, min_monthly_fee: 5000, currency_code: 'INR' });
            expect(res.status).toBe(201);
            expect(res.body.data.name).toBe(name);
            expect(res.body.data.sales_pct).toBe(3.0);
            expect(res.body.data.min_monthly_fee).toBe(5000);
        });

        it('siteAdmin role → 201', async () => {
            const res = await request(app).post('/api/subscriptions/plans')
                .set(auth('siteAdmin'))
                .send({ name: `SAPlan-${uid()}` });
            expect(res.status).toBe(201);
        });
    });

    // ── POST /api/subscriptions ───────────────────────────────────────────────
    describe('POST /api/subscriptions', () => {
        it('no auth → 401', async () => {
            const res = await request(app).post('/api/subscriptions')
                .send({ tenant_id: 1, plan_id: 1, effective_from: '2025-01-01' });
            expect(res.status).toBe(401);
        });

        it('staff role → 403', async () => {
            const res = await request(app).post('/api/subscriptions')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2025-01-01' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400 with error', async () => {
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

        it('valid → 201 with subscription record, effective_to null', async () => {
            const t = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'SubAssign Tenant', slug: `sa-${uid()}` });
            const tid = t.body.data.id;

            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tid, plan_id: planId, effective_from: '2025-01-01' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.tenant_id).toBe(tid);
            expect(res.body.data.plan_id).toBe(planId);
            expect(res.body.data.effective_to).toBeNull();
        });

        it('assigning a second plan closes the previous subscription', async () => {
            const t = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'Replace Sub Tenant', slug: `rs-${uid()}` });
            const tid = t.body.data.id;

            const plan2Res = await request(app).post('/api/subscriptions/plans')
                .set(auth('admin'))
                .send({ name: `Plan2-${uid()}`, sales_pct: 4.0 });
            const plan2Id = plan2Res.body.data.id;

            await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tid, plan_id: planId, effective_from: '2025-01-01' });

            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({ tenant_id: tid, plan_id: plan2Id, effective_from: '2025-06-01' });
            expect(res.status).toBe(201);
            expect(res.body.data.plan_id).toBe(plan2Id);
            expect(res.body.data.effective_to).toBeNull();
        });

        it('custom overrides are stored when provided', async () => {
            const t = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'Custom Sub Tenant', slug: `cs-${uid()}` });
            const tid = t.body.data.id;

            const res = await request(app).post('/api/subscriptions')
                .set(auth('admin'))
                .send({
                    tenant_id: tid, plan_id: planId, effective_from: '2025-01-01',
                    custom_sales_pct: 1.75, custom_rental_pct: 0.8, notes: 'Negotiated rate',
                });
            expect(res.status).toBe(201);
            expect(res.body.data.custom_sales_pct).toBe(1.75);
            expect(res.body.data.notes).toBe('Negotiated rate');
        });
    });
});
