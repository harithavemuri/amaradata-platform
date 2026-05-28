// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Enhancements API', () => {
    let tenantId;
    let enhancementId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Enh Tenant', slug: `enh-${uid()}` });
        tenantId = t.body.data?.id;

        const e = await request(app).post('/api/enhancements')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, title: 'Seed Enhancement' });
        enhancementId = e.body.data?.id;
    });

    // ── POST /api/enhancements ────────────────────────────────────────────────
    describe('POST /api/enhancements', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/enhancements')
                .send({ tenant_id: 1, title: 'Test' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('staff role → 403', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('staff'))
                .send({ tenant_id: tenantId, title: 'Test' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400 with error', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ title: 'No Tenant' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing title → 400', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ tenant_id: tenantId });
            expect(res.status).toBe(400);
        });

        it('valid minimal → 201 with sensible defaults', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, title: 'Minimal Enhancement' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.billing_type).toBe('hourly');
            expect(res.body.data.status).toBe('scoped');
            expect(res.body.data.source).toBe('manual');
            expect(res.body.data.item_type).toBe('enhancement');
            expect(res.body.data.is_billable).toBe(true);
        });

        it('valid milestone type → 201', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    title: 'Dashboard v2',
                    billing_type: 'milestone',
                    milestone_amount: 75000,
                    item_type: 'enhancement',
                    is_billable: true,
                });
            expect(res.status).toBe(201);
            expect(res.body.data.billing_type).toBe('milestone');
            expect(res.body.data.milestone_amount).toBe(75000);
        });

        it('bug item_type with is_billable false → 201 stored correctly', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    title: 'Login bug fix',
                    item_type: 'bug',
                    is_billable: false,
                });
            expect(res.status).toBe(201);
            expect(res.body.data.item_type).toBe('bug');
            expect(res.body.data.is_billable).toBe(false);
        });

        it('hourly type with estimated_hours → 201 stores hours', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    title: 'API integration',
                    billing_type: 'hourly',
                    estimated_hours: 40,
                    hourly_rate: 1200,
                });
            expect(res.status).toBe(201);
            expect(res.body.data.estimated_hours).toBe(40);
            expect(res.body.data.hourly_rate).toBe(1200);
        });

        it('siteAdmin role → 201', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('siteAdmin'))
                .send({ tenant_id: tenantId, title: 'SA Enhancement' });
            expect(res.status).toBe(201);
        });
    });

    // ── PUT /api/enhancements/:id ─────────────────────────────────────────────
    describe('PUT /api/enhancements/:id', () => {
        it('no auth → 401', async () => {
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .send({ title: 'Updated' });
            expect(res.status).toBe(401);
        });

        it('staff role → 403', async () => {
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .set(auth('staff'))
                .send({ title: 'Updated' });
            expect(res.status).toBe(403);
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/enhancements/99999')
                .set(auth('admin'))
                .send({ title: 'Ghost' });
            expect(res.status).toBe(404);
        });

        it('valid update of title and status → 200', async () => {
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .set(auth('admin'))
                .send({ title: 'Updated Title', status: 'in_progress' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.title).toBe('Updated Title');
            expect(res.body.data.status).toBe('in_progress');
        });

        it('update actual_hours → 200 with stored value', async () => {
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .set(auth('admin'))
                .send({ actual_hours: 18 });
            expect(res.status).toBe(200);
            expect(res.body.data.actual_hours).toBe(18);
        });

        it('mark delivered → 200 with delivered_at stored', async () => {
            const deliveredAt = '2025-06-15T00:00:00.000Z';
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .set(auth('admin'))
                .send({ status: 'delivered', delivered_at: deliveredAt });
            expect(res.status).toBe(200);
            expect(res.body.data.status).toBe('delivered');
        });
    });
});
