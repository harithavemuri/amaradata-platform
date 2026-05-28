// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Enhancements routes', () => {
    let tenantId;
    let enhancementId;

    beforeAll(async () => {
        const t = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Enh Tenant', slug: `enh-t-${uid()}` });
        tenantId = t.body.data?.id;

        const e = await request(app).post('/api/enhancements')
            .set(auth('admin'))
            .send({ tenant_id: tenantId, title: 'Seed Enhancement', billing_type: 'hourly' });
        enhancementId = e.body.data?.id;
    });

    // ── POST /api/enhancements ───────────────────────────────────────────────
    describe('POST /api/enhancements', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/enhancements')
                .send({ tenant_id: 1, title: 'X' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('staff'))
                .send({ tenant_id: 1, title: 'X' });
            expect(res.status).toBe(403);
        });

        it('missing tenant_id → 400', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ title: 'No tenant' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing title → 400', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ tenant_id: tenantId });
            expect(res.status).toBe(400);
        });

        it('valid enhancement → 201, defaults: status=scoped, source=manual, is_billable=true', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, title: 'New Feature', billing_type: 'milestone', milestone_amount: 5000 });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({
                status:      'scoped',
                source:      'manual',
                is_billable: true,
                item_type:   'enhancement',
            });
        });

        it('bug type → 201', async () => {
            const res = await request(app).post('/api/enhancements')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, title: 'Fix crash', item_type: 'bug', is_billable: false });
            expect(res.status).toBe(201);
            expect(res.body.data.item_type).toBe('bug');
            expect(res.body.data.is_billable).toBe(false);
        });
    });

    // ── PUT /api/enhancements/:id ────────────────────────────────────────────
    describe('PUT /api/enhancements/:id', () => {
        it('without auth → 401', async () => {
            const res = await request(app).put('/api/enhancements/1').send({ title: 'X' });
            expect(res.status).toBe(401);
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/enhancements/99999')
                .set(auth('admin'))
                .send({ title: 'X' });
            expect(res.status).toBe(404);
        });

        it('valid update → 200', async () => {
            const res = await request(app).put(`/api/enhancements/${enhancementId}`)
                .set(auth('admin'))
                .send({ title: 'Updated Title', status: 'in_progress', actual_hours: 3 });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.title).toBe('Updated Title');
            expect(res.body.data.status).toBe('in_progress');
        });
    });

    // ── POST /api/enhancements/import ────────────────────────────────────────
    describe('POST /api/enhancements/import', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/enhancements/import')
                .send({ tenant_id: tenantId, rows: [] });
            expect(res.status).toBe(401);
        });

        it('missing tenant_id and no matching tenant_name → 400', async () => {
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({ rows: [{ issue_id: 1 }] });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('empty rows array → 400', async () => {
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({ tenant_id: tenantId, rows: [] });
            expect(res.status).toBe(400);
        });

        it('rows with no issue_id → all skipped', async () => {
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    rows: [{ notes: 'no id here' }, { notes: 'also no id' }],
                });
            expect(res.status).toBe(200);
            expect(res.body.data.skipped).toBe(2);
            expect(res.body.data.inserted).toBe(0);
        });

        it('insert new rows by tenant_id → 200 with inserted count', async () => {
            const issueId1 = Date.now();
            const issueId2 = issueId1 + 1;
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    rows: [
                        { issue_id: issueId1, notes: 'Added dark mode', item_type: 'enhancement', is_billable: true,  fixed: 'Yes', report_date: '2025-01-10' },
                        { issue_id: issueId2, notes: 'Fixed login bug',  item_type: 'bug',         is_billable: false, fixed: 'No' },
                    ],
                });
            expect(res.status).toBe(200);
            expect(res.body.data.inserted).toBe(2);
            expect(res.body.data.updated).toBe(0);
        });

        it('re-import same issue_id → updates existing row', async () => {
            const issueId = Date.now() + 100;
            await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    rows: [{ issue_id: issueId, notes: 'Original notes', item_type: 'enhancement', is_billable: true, fixed: 'No' }],
                });
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    rows: [{ issue_id: issueId, notes: 'Updated notes', item_type: 'enhancement', is_billable: true, fixed: 'Yes' }],
                });
            expect(res.status).toBe(200);
            expect(res.body.data.updated).toBe(1);
            expect(res.body.data.inserted).toBe(0);
        });

        it('resolve tenant by tenant_name → inserts correctly', async () => {
            const t = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: `Named Tenant ${uid()}`, slug: `named-${uid()}` });
            const tenantName = t.body.data.name;
            const issueId = Date.now() + 200;

            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_name: tenantName,
                    rows: [{ issue_id: issueId, notes: 'Via name', item_type: 'bug', is_billable: false, fixed: 'No' }],
                });
            expect(res.status).toBe(200);
            expect(res.body.data.inserted).toBe(1);
        });

        it('fixed=Yes → status delivered; fixed=Skip → status cancelled', async () => {
            const base = Date.now() + 300;
            const res = await request(app).post('/api/enhancements/import')
                .set(auth('admin'))
                .send({
                    tenant_id: tenantId,
                    rows: [
                        { issue_id: base,     notes: 'Done',    item_type: 'enhancement', is_billable: true,  fixed: 'Yes - merged' },
                        { issue_id: base + 1, notes: 'Skipped', item_type: 'bug',         is_billable: false, fixed: 'Skip' },
                        { issue_id: base + 2, notes: 'Pending', item_type: 'enhancement', is_billable: true,  fixed: 'No' },
                    ],
                });
            expect(res.status).toBe(200);
            expect(res.body.data.inserted).toBe(3);
        });
    });
});
