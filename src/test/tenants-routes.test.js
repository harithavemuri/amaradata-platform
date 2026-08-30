// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, auth, assertJson } from './helpers.js';

describe('Tenants routes', () => {
    let tenantId;

    beforeAll(async () => {
        const res = await request(app).post('/api/tenants')
            .set(auth('admin'))
            .send({
                name: 'Seed Tenant', slug: `seed-${uid()}`, status: 'active',
                tenant_db_password: 'super-secret-db-password',
                owner_portal_api_key: 'super-secret-owner-portal-key',
            });
        tenantId = res.body.data?.id;
    });

    // GET /api/tenants only requires requireAuth (any staff role, not just
    // admin) — it must never return the plaintext credential columns
    // (tenant_db_password, owner_portal_api_key, etc.), which SELECT * would
    // otherwise leak to every logged-in staff member regardless of role.
    describe('GET /api/tenants', () => {
        it('without auth → 401', async () => {
            const res = await request(app).get('/api/tenants');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff role → 200, list still usable for tenant pickers', async () => {
            const res = await request(app).get('/api/tenants').set(auth('staff'));
            assertJson(res);
            expect(res.status).toBe(200);
            const seeded = res.body.data.find((t) => t.id === tenantId);
            expect(seeded).toBeTruthy();
            expect(seeded.name).toBe('Seed Tenant');
        });

        it('never includes plaintext DB or owner-portal credentials, for any role', async () => {
            const res = await request(app).get('/api/tenants').set(auth('staff'));
            assertJson(res);
            const seeded = res.body.data.find((t) => t.id === tenantId);
            for (const field of [
                'tenant_db_password', 'tenant_db_secret_arn', 'tenant_db_host',
                'tenant_db_port', 'tenant_db_name', 'tenant_db_user',
                'owner_portal_api_key', 'owner_portal_api_key_secret_arn',
            ]) {
                expect(seeded).not.toHaveProperty(field);
            }
        });
    });

    // ── POST /api/tenants ────────────────────────────────────────────────────
    describe('POST /api/tenants', () => {
        it('without auth → 401', async () => {
            const res = await request(app).post('/api/tenants')
                .send({ name: 'X', slug: 'x' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('staff'))
                .send({ name: 'X', slug: 'x' });
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('missing name → 400', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ slug: 'no-name' });
            assertJson(res);
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('missing slug → 400', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('admin'))
                .send({ name: 'No Slug' });
            assertJson(res);
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
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toMatchObject({ slug, status: 'active' });
            expect(res.body.data).toHaveProperty('id');
        });

        it('siteAdmin role → 201', async () => {
            const res = await request(app).post('/api/tenants')
                .set(auth('siteAdmin'))
                .send({ name: 'SA Tenant', slug: `sa-${uid()}` });
            assertJson(res);
            expect(res.status).toBe(201);
        });
    });

    // ── PUT /api/tenants/:id ─────────────────────────────────────────────────
    describe('PUT /api/tenants/:id', () => {
        it('without auth → 401', async () => {
            const res = await request(app).put('/api/tenants/1').send({ name: 'X' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('with staff role → 403', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('staff'))
                .send({ name: 'Updated' });
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('nonexistent id → 404', async () => {
            const res = await request(app).put('/api/tenants/99999')
                .set(auth('admin'))
                .send({ name: 'Updated' });
            assertJson(res);
            expect(res.status).toBe(404);
        });

        it('valid update → 200 with updated data', async () => {
            const res = await request(app).put(`/api/tenants/${tenantId}`)
                .set(auth('admin'))
                .send({ name: 'Updated Name', status: 'suspended' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe('Updated Name');
            expect(res.body.data.status).toBe('suspended');
        });
    });
});
