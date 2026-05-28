// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth } from './helpers.js';

describe('Tenants routes', () => {
    let tenantId;

    beforeAll(async () => {
        const res = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({ name: 'Seed Tenant', slug: `seed-${uid()}`, status: 'active' });
        tenantId = res.body.data?.id;
    });

    // ── POST /api/tenants ────────────────────────────────────────────────────
    describe('POST /api/tenants', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/tenants')
                .send({ name: 'X', slug: 'x' });
            expect(res.status).toBe(401);
            expect(res.headers['content-type']).toMatch(/json/);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('staff'))
                .send({ name: 'X', slug: 'x' });
            expect(res.status).toBe(403);
        });

        it('missing name → 400', async () => {
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

        it('valid data → 201 with new tenant', async () => {
            const slug = `t-${uid()}`;
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({
                    name: 'ACME Corp', slug, contact_email: 'acme@example.com',
                    status: 'active', site_url: 'https://acme.example.com',
                });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({ slug, status: 'active' });
            expect(res.body.data).toHaveProperty('id');
        });

        it('siteAdmin role → 201', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('siteAdmin'))
                .send({ name: 'SA Tenant', slug: `sa-${uid()}` });
            expect(res.status).toBe(201);
        });
    });

    // ── PUT /api/tenants/:id ─────────────────────────────────────────────────
    describe('PUT /api/tenants/:id', () => {
        it('without auth → 401', async () => {
            const res = await request(app).put('/api/tenants/1').send({ name: 'X' });
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('staff'))
                .send({ name: 'Updated' });
            expect(res.status).toBe(403);
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/tenants/99999')
                .set(auth('admin'))
                .send({ name: 'Updated' });
            expect(res.status).toBe(404);
        });

        it('valid update → 200 with updated data', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('admin'))
                .send({ name: 'Updated Name', status: 'suspended' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe('Updated Name');
            expect(res.body.data.status).toBe('suspended');
        });
    });
});
