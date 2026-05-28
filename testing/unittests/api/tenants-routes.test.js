// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, auth } from '../helpers.js';

describe('Tenants API', () => {
    let tenantId;

    beforeAll(async () => {
        const res = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Seed Tenant', slug: `seed-${uid()}`, status: 'active' });
        tenantId = res.body.data?.id;
    });

    // ── POST /api/tenants ─────────────────────────────────────────────────────
    describe('POST /api/tenants', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/tenants')
                .send({ name: 'X', slug: 'x' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('staff role → 403', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('staff'))
                .send({ name: 'X', slug: 'x' });
            expect(res.status).toBe(403);
        });

        it('missing name → 400 with error field', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ slug: 'no-name' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing slug → 400', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'No Slug' });
            expect(res.status).toBe(400);
        });

        it('valid minimal → 201 with tenant id and slug', async () => {
            const slug = `t-${uid()}`;
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'Acme Corp', slug, status: 'active' });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({ slug, status: 'active' });
            expect(res.body.data).toHaveProperty('id');
        });

        it('valid with all optional fields → 201', async () => {
            const slug = `full-${uid()}`;
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({
                    name: 'Full Corp', slug,
                    contact_email: 'full@example.com',
                    status: 'active',
                    site_url: 'https://full.example.com',
                });
            expect(res.status).toBe(201);
            expect(res.body.data.contact_email).toBe('full@example.com');
        });

        it('siteAdmin role → 201', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('siteAdmin'))
                .send({ name: 'SA Tenant', slug: `sa-${uid()}` });
            expect(res.status).toBe(201);
        });
    });

    // ── PUT /api/tenants/:id ──────────────────────────────────────────────────
    describe('PUT /api/tenants/:id', () => {
        it('no auth → 401', async () => {
            const res = await request(app).put('/api/tenants/1').send({ name: 'X' });
            expect(res.status).toBe(401);
        });

        it('staff role → 403', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('staff'))
                .send({ name: 'Updated' });
            expect(res.status).toBe(403);
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/tenants/99999')
                .set(auth('admin'))
                .send({ name: 'Ghost' });
            expect(res.status).toBe(404);
        });

        it('valid update → 200 with updated fields', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('admin'))
                .send({ name: 'Renamed Corp', status: 'suspended' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe('Renamed Corp');
            expect(res.body.data.status).toBe('suspended');
        });

        it('siteAdmin role → 200', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('siteAdmin'))
                .send({ name: 'SA Updated' });
            expect(res.status).toBe(200);
        });
    });
});
