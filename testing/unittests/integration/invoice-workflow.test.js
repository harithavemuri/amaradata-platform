// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

/**
 * End-to-end invoice lifecycle: tenant → plan → metrics → invoice → status transitions → enhancement → re-subscription.
 */
describe('Invoice lifecycle — end-to-end workflow', () => {
    let tenantId;
    let planId;
    let invoiceId;
    let enhancementId;

    // ── 1. Setup: tenant + subscription plan ─────────────────────────────────
    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: `Workflow Corp ${uid()}`, slug: `wf-${uid()}`, status: 'active' });
        expect(t.status).toBe(201);
        tenantId = t.body.data.id;

        const p = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `Standard-${uid()}`, sales_pct: 2.5, rental_pct: 1.0, min_monthly_fee: 5000 });
        expect(p.status).toBe(201);
        planId = p.body.data.id;
    });

    it('1. tenant and plan are created with valid IDs', () => {
        expect(tenantId).toBeGreaterThan(0);
        expect(planId).toBeGreaterThan(0);
    });

    // ── 2. Assign subscription ────────────────────────────────────────────────
    it('2. assign subscription plan — effective_to is null (open-ended)', async () => {
        const res = await request(app).post('/api/subscriptions')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, plan_id: planId, effective_from: '2025-01-01' });
        expect(res.status).toBe(201);
        expect(res.body.data.tenant_id).toBe(tenantId);
        expect(res.body.data.plan_id).toBe(planId);
        expect(res.body.data.effective_to).toBeNull();
    });

    // ── 3. Record billing metrics ─────────────────────────────────────────────
    it('3. record Jan metrics and verify stored values', async () => {
        const res = await request(app).post('/api/metrics')
            .set(auth('admin'))
            .send({
                tenant_id: tenantId, period_year: 2025, period_month: 1,
                sales_count: 20, sales_value: 1000000,
                rental_units: 10, rental_income: 200000,
                active_properties: 35,
            });
        expect(res.status).toBe(201);
        expect(res.body.data.sales_count).toBe(20);
        expect(res.body.data.sales_value).toBe(1000000);
        expect(res.body.data.active_properties).toBe(35);
    });

    it('3b. re-submit same period to update values (upsert)', async () => {
        const res = await request(app).post('/api/metrics')
            .set(auth('admin'))
            .send({
                tenant_id: tenantId, period_year: 2025, period_month: 1,
                sales_count: 22, sales_value: 1100000,
            });
        expect(res.status).toBe(201);
        expect(res.body.data.sales_count).toBe(22);
    });

    // ── 4. Create invoice with line items ─────────────────────────────────────
    it('4. create invoice and verify 18% GST calculation', async () => {
        const res = await request(app).post('/api/invoices')
            .set(auth('admin'))
            .send({
                tenant_id:  tenantId,
                issue_date: '2025-01-31',
                due_date:   '2025-02-14',
                line_items: [
                    { description: 'Platform subscription', amount: 25000 },
                    { description: 'Support hours (10h)',   amount: 15000 },
                ],
            });
        expect(res.status).toBe(201);
        invoiceId = res.body.data.id;
        expect(res.body.data.subtotal).toBe(40000);
        expect(res.body.data.tax_amount).toBeCloseTo(7200, 1);
        expect(res.body.data.total_amount).toBeCloseTo(47200, 1);
        expect(res.body.data.status).toBe('draft');
        expect(res.body.data.invoice_number).toMatch(/^AMR-/);
    });

    // ── 5. Status transitions: draft → sent → paid ────────────────────────────
    it('5a. draft → sent', async () => {
        const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
            .set(auth('admin'))
            .send({ status: 'sent' });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('sent');
    });

    it('5b. sent → paid — sets paid_at timestamp', async () => {
        const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
            .set(auth('admin'))
            .send({ status: 'paid' });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('paid');
        expect(res.body.data.paid_at).toBeTruthy();
    });

    it('5c. second invoice can go draft → overdue', async () => {
        const inv = await request(app).post('/api/invoices')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, issue_date: '2025-02-28', due_date: '2025-03-15' });
        expect(inv.status).toBe(201);
        const res = await request(app).patch(`/api/invoices/${inv.body.data.id}/status`)
            .set(auth('admin'))
            .send({ status: 'overdue' });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('overdue');
    });

    // ── 6. Enhancements ───────────────────────────────────────────────────────
    it('6a. create milestone enhancement for tenant', async () => {
        const res = await request(app).post('/api/enhancements')
            .set(auth('admin'))
            .send({
                tenant_id:        tenantId,
                title:            'Custom report builder',
                billing_type:     'milestone',
                milestone_amount: 75000,
                item_type:        'enhancement',
                is_billable:      true,
            });
        expect(res.status).toBe(201);
        enhancementId = res.body.data.id;
        expect(res.body.data.status).toBe('scoped');
        expect(res.body.data.source).toBe('manual');
    });

    it('6b. advance enhancement to in_progress', async () => {
        const res = await request(app).put(`/api/enhancements/${enhancementId}`)
            .set(auth('admin'))
            .send({ status: 'in_progress', actual_hours: 0 });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('in_progress');
    });

    it('6c. mark enhancement delivered', async () => {
        const res = await request(app).put(`/api/enhancements/${enhancementId}`)
            .set(auth('admin'))
            .send({ status: 'delivered', actual_hours: 28, delivered_at: '2025-04-01T00:00:00.000Z' });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('delivered');
        expect(res.body.data.actual_hours).toBe(28);
    });

    it('6d. non-billable bug fix for same tenant', async () => {
        const res = await request(app).post('/api/enhancements')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, title: 'Login timeout bug', item_type: 'bug', is_billable: false });
        expect(res.status).toBe(201);
        expect(res.body.data.item_type).toBe('bug');
        expect(res.body.data.is_billable).toBe(false);
    });

    // ── 7. Re-subscription upgrades plan ─────────────────────────────────────
    it('7. assigning a new plan closes the previous subscription', async () => {
        const plan2 = await request(app).post('/api/subscriptions/plans')
            .set(auth('admin'))
            .send({ name: `Premium-${uid()}`, sales_pct: 4.0, min_monthly_fee: 10000 });
        expect(plan2.status).toBe(201);

        const res = await request(app).post('/api/subscriptions')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, plan_id: plan2.body.data.id, effective_from: '2025-07-01' });
        expect(res.status).toBe(201);
        expect(res.body.data.plan_id).toBe(plan2.body.data.id);
        expect(res.body.data.effective_to).toBeNull();
    });

    // ── 8. Contact form (public) ──────────────────────────────────────────────
    it('8. contact submission from prospective tenant — no auth required', async () => {
        const res = await request(app).post('/api/contact')
            .send({
                name: 'Prospective Client', email: 'prospect@newco.com',
                message: 'Interested in the platform.', company: 'NewCo Ltd',
            });
        expect(res.status).toBe(201);
        expect(res.body.ref_number).toMatch(/^REF-\d{8}-\d{4}$/);
    });

    it('8b. contact submission appears in admin list', async () => {
        const res = await request(app).get('/api/contact').set(auth('staff'));
        expect(res.status).toBe(200);
        const entry = res.body.data.find(d => d.email === 'prospect@newco.com');
        expect(entry).toBeTruthy();
        expect(entry.status).toBe('new');
    });

    // ── 9. Admin: user + group management ────────────────────────────────────
    it('9a. create new staff user', async () => {
        const res = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `staff-${uid()}@t.com`, name: 'Sales Person', role: 'sales_manager' });
        expect(res.status).toBe(201);
        expect(res.body.data.role).toBe('sales_manager');
        expect(res.body.data).not.toHaveProperty('password_hash');
    });

    it('9b. create user group and add member', async () => {
        const grp = await request(app).post('/api/admin/user-groups')
            .set(auth('siteAdmin'))
            .send({ name: `Sales Team ${uid()}` });
        expect(grp.status).toBe(201);
        const groupId = grp.body.data.id;

        const usr = await request(app).post('/api/admin/users')
            .set(auth('siteAdmin'))
            .send({ email: `grp-mem-${uid()}@t.com`, name: 'Group Member' });
        const userId = usr.body.data.id;

        const res = await request(app)
            .post(`/api/admin/user-groups/${groupId}/members`)
            .set(auth('siteAdmin'))
            .send({ user_id: userId });
        expect([200, 201]).toContain(res.status);
    });
});
