// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Invoices API', () => {
    let tenantId;
    let invoiceId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Invoice Tenant', slug: `inv-${uid()}` });
        tenantId = t.body.data?.id;

        const inv = await request(app).post('/api/invoices')
            .set(auth('admin'))
            .send({
                tenant_id:  tenantId,
                issue_date: '2025-01-01',
                due_date:   '2025-01-31',
                line_items: [{ description: 'Setup fee', amount: 5000 }],
            });
        invoiceId = inv.body.data?.id;
    });

    // ── POST /api/invoices ────────────────────────────────────────────────────
    describe('POST /api/invoices', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/invoices')
                .send({ tenant_id: 1, issue_date: '2025-01-01', due_date: '2025-01-31' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('staff role → 403', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('staff'))
                .send({ tenant_id: 1, issue_date: '2025-01-01', due_date: '2025-01-31' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400 with error', async () => {
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

        it('missing due_date → 400', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, issue_date: '2025-01-01' });
            expect(res.status).toBe(400);
        });

        it('no line items → 201, totals zero, status draft', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, issue_date: '2025-02-01', due_date: '2025-02-28' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.total_amount).toBe(0);
            expect(res.body.data.subtotal).toBe(0);
            expect(res.body.data.status).toBe('draft');
        });

        it('invoice_number has AMR- prefix', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, issue_date: '2025-03-01', due_date: '2025-03-31' });
            expect(res.status).toBe(201);
            expect(res.body.data.invoice_number).toMatch(/^AMR-/);
        });

        it('line items → 201, computes 18% GST correctly', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({
                    tenant_id:  tenantId,
                    issue_date: '2025-04-01',
                    due_date:   '2025-04-30',
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

        it('single line item — subtotal equals item amount', async () => {
            const res = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({
                    tenant_id:  tenantId,
                    issue_date: '2025-05-01',
                    due_date:   '2025-05-31',
                    line_items: [{ description: 'One item', amount: 50000 }],
                });
            expect(res.status).toBe(201);
            expect(res.body.data.subtotal).toBe(50000);
            expect(res.body.data.tax_amount).toBeCloseTo(9000, 1);
            expect(res.body.data.total_amount).toBeCloseTo(59000, 1);
        });

        it('two invoices get distinct invoice_numbers', async () => {
            const [r1, r2] = await Promise.all([
                request(app).post('/api/invoices').set(auth('admin'))
                    .send({ tenant_id: tenantId, issue_date: '2025-06-01', due_date: '2025-06-30' }),
                request(app).post('/api/invoices').set(auth('admin'))
                    .send({ tenant_id: tenantId, issue_date: '2025-06-01', due_date: '2025-06-30' }),
            ]);
            expect(r1.body.data.invoice_number).not.toBe(r2.body.data.invoice_number);
        });
    });

    // ── PATCH /api/invoices/:id/status ────────────────────────────────────────
    describe('PATCH /api/invoices/:id/status', () => {
        it('no auth → 401', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .send({ status: 'sent' });
            expect(res.status).toBe(401);
        });

        it('invalid status value → 400', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'bad-status' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('nonexistent invoice → 404', async () => {
            const res = await request(app).patch('/api/invoices/99999/status')
                .set(auth('admin'))
                .send({ status: 'sent' });
            expect(res.status).toBe(404);
        });

        it('status "sent" → 200', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'sent' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.status).toBe('sent');
        });

        it('status "paid" → 200 and sets paid_at timestamp', async () => {
            const res = await request(app).patch(`/api/invoices/${invoiceId}/status`)
                .set(auth('admin'))
                .send({ status: 'paid' });
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('paid');
            expect(res.body.data.paid_at).toBeTruthy();
        });

        it.each(['draft', 'overdue', 'cancelled'])('status "%s" → 200', async (status) => {
            const inv = await request(app).post('/api/invoices')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, issue_date: '2025-07-01', due_date: '2025-07-31' });
            const res = await request(app).patch(`/api/invoices/${inv.body.data.id}/status`)
                .set(auth('admin'))
                .send({ status });
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe(status);
        });
    });
});
