// @vitest-environment node
// GET /api/invoices/suggest-line-items — computes what a tenant actually
// owes for a period from real data (billing_metrics.sales_value/
// rental_income × the tenant's active subscription_plans.sales_pct/
// rental_pct, or its tenant_subscriptions.custom_*_pct override), floored
// at the plan's min_monthly_fee. Previously "Sales %"/"Rental %" were just
// labels in invoices.html's line-item dropdown — a staff member had to
// compute the percentage by hand and type in the result. This endpoint is
// the actual computation, review-and-edit before saving, never auto-created.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('GET /api/invoices/suggest-line-items', () => {
    let tenantId, planId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Suggest Line Items Tenant', slug: `suggest-li-${uid()}` });
        tenantId = t.body.data.id;

        const p = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `Suggest Plan ${uid()}`, sales_pct: 5, rental_pct: 10, min_monthly_fee: 2000, currency_code: 'INR' });
        planId = p.body.data.id;

        await request(app).post('/api/subscriptions')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2020-01-01' });

        await request(app).post('/api/metrics')
            .set(auth('admin'))
            .send({
                tenant_id: tenantId, period_year: 2026, period_month: 6,
                sales_count: 2, sales_value: 1000000, rental_units: 3, rental_income: 50000, active_properties: 10,
            });
    });

    it('without auth → 401', async () => {
        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${tenantId}&period_year=2026&period_month=6`);
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('missing query params → 400', async () => {
        const res = await request(app).get('/api/invoices/suggest-line-items').set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(400);
    });

    it('no billing_metrics row for that period → 404', async () => {
        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${tenantId}&period_year=2019&period_month=1`).set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(404);
    });

    it('computes sales and rental commission lines from the plan\'s percentages', async () => {
        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${tenantId}&period_year=2026&period_month=6`).set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(200);
        const { line_items } = res.body.data;
        const sales = line_items.find(l => l.billing_type === 'sales_pct');
        const rental = line_items.find(l => l.billing_type === 'rental_pct');
        expect(sales.amount).toBe(50000);   // 5% of 1,000,000
        expect(rental.amount).toBe(5000);   // 10% of 50,000
        // Combined (55,000) already clears the 2,000 floor — no top-up line.
        expect(line_items.find(l => l.billing_type === 'fixed')).toBeUndefined();
    });

    it('a per-tenant custom_rental_pct override wins over the plan default', async () => {
        await request(app).post('/api/subscriptions')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2026-01-01', custom_rental_pct: 20 });

        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${tenantId}&period_year=2026&period_month=6`).set(auth('admin'));
        assertJson(res);
        const rental = res.body.data.line_items.find(l => l.billing_type === 'rental_pct');
        expect(rental.amount).toBe(10000); // 20% of 50,000, not the plan's 10%
    });

    it('below the minimum monthly fee, a top-up line item closes the gap', async () => {
        const smallPlan = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `Small Plan ${uid()}`, sales_pct: 0, rental_pct: 1, min_monthly_fee: 10000, currency_code: 'INR' });
        await request(app).post('/api/subscriptions')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, plan_id: smallPlan.body.data.id, effective_from: '2026-02-01' });

        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${tenantId}&period_year=2026&period_month=6`).set(auth('admin'));
        assertJson(res);
        const { line_items } = res.body.data;
        const rental = line_items.find(l => l.billing_type === 'rental_pct');
        expect(rental.amount).toBe(500); // 1% of 50,000
        const topUp = line_items.find(l => l.billing_type === 'fixed');
        expect(topUp).toBeTruthy();
        expect(topUp.amount).toBe(9500); // tops 500 up to the 10,000 floor
    });

    it('no subscription covering that period → 400 with a clear message', async () => {
        const t2 = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'No Plan Tenant', slug: `no-plan-${uid()}` });
        await request(app).post('/api/metrics')
            .set(auth('admin'))
            .send({ tenant_id: t2.body.data.id, period_year: 2026, period_month: 6, sales_value: 1000, rental_income: 1000 });

        const res = await request(app).get(`/api/invoices/suggest-line-items?tenant_id=${t2.body.data.id}&period_year=2026&period_month=6`).set(auth('admin'));
        assertJson(res);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/subscription/i);
    });
});
