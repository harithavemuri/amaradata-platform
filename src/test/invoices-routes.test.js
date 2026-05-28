// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Invoices routes', () => {
    let tenantId;
    let invoiceId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Invoice Tenant', slug: `inv-t-${uid()}` });
        tenantId = t.body.data?.id;

        const inv = await request(app).post('/api/invoices')
            .set(auth('admin'))
            .send({
                tenant_id: tenantId,
                issue_date: '2025-01-01',
                due_date:   '2025-01-31',
                line_items: [{ description: 'Setup', amount: 5000 }],
            });
        invoiceId = inv.body.data?.id;
    });

    // ── POST /api/invoices ───────────────────────────────────────────────────
    describe('POST /api/invoices', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/invoices')
                .send({ tenant_id: 1, issue_date: '2025-01-01', due_date: '2025-01-31' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('staff'))
                .send({ tenant_id: 1, issue_date: '2025-01-01', due_date: '2025-01-31' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ issue_date: '2025-01-01', due_date: '2025-01-31' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing issue_date → 400', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, due_date: '2025-01-31' });
            expect(res.status).toBe(400);
        });

        it('valid with no line items → 201, totals all zero', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({
                    tenant_id:  tenantId,
                    issue_date: '2025-02-01',
                    due_date:   '2025-02-28',
                });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.total_amount).toBe(0);
            expect(res.body.data.status).toBe('draft');
            expect(res.body.data.invoice_number).toMatch(/^AMR-/);
        });

        it('valid with line items → 201, totals calculated (18% tax)', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({
                    tenant_id:  tenantId,
                    issue_date: '2025-03-01',
                    due_date:   '2025-03-31',
                    line_items: [
                        { description: 'Dev work', amount: 10000 },
                        { description: 'Support',  amount: 2000  },
                    ],
                });
            expect(res.status).toBe(201);
            expect(res.body.data.subtotal).toBe(12000);
            expect(res.body.data.tax_amount).toBeCloseTo(2160, 1);
            expect(res.body.data.total_amount).toBeCloseTo(14160, 1);
        });
    });

    // ── PATCH /api/invoices/:id/status ───────────────────────────────────────
    describe('PATCH /api/invoices/:id/status', () => {
        it('without auth → 401', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .send({ status: 'sent' });
            expect(res.status).toBe(401);
        });

        it('invalid status value → 400', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'invalid-status' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('nonexistent invoice → 404', async () => {
            const res = await request(app).patch('/api/invoices/99999/status')
                .set(auth('admin'))
                .send({ status: 'sent' });
            expect(res.status).toBe(404);
        });

        it('valid status "sent" → 200', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'sent' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.status).toBe('sent');
        });

        it('valid status "paid" → 200, sets paid_at', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'paid' });
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('paid');
            expect(res.body.data.paid_at).toBeTruthy();
        });

        it('all valid statuses accepted', async () => {
            for (const status of ['draft', 'overdue', 'cancelled']) {
                const inv = await request(app).post('/api/invoices')
                    .set(auth('admin'))
                    .send({ tenant_id: tenantId, issue_date: '2025-04-01', due_date: '2025-04-30' });
                const id = inv.body.data.id;
                const res = await request(app).patch(`/api/invoices/${id}/status`)
                    .set(auth('admin'))
                    .send({ status });
                expect(res.status).toBe(200);
                expect(res.body.data.status).toBe(status);
            }
        });
    });
});
