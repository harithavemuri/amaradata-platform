// @vitest-environment node
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../server.js';
import { uid, assertJson } from '../helpers.js';
import jwt from 'jsonwebtoken';

const SETUP_KEY = 'test-jwt-secret-32-chars-minimum!!';

describe('Auth — full workflow', () => {
    const email    = `auth-${uid()}@example.com`;
    const password = 'TestPass1234!';
    let accessToken;
    let refreshToken;

    // ── Step 1: create-user ───────────────────────────────────────────────────
    describe('POST /api/auth/create-user', () => {
        it('wrong setup_key → 403', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email: `x-${uid()}@t.com`, password, name: 'X', setup_key: 'wrong-key' });
            assertJson(res);
            expect(res.status).toBe(403);
        });

        it('valid setup_key → 201 with user object (no password_hash)', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, password, name: 'Auth Test User', role: 'staff', setup_key: SETUP_KEY });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.email).toBe(email);
            expect(res.body.data.role).toBe('staff');
            expect(res.body.data).not.toHaveProperty('password_hash');
        });

        it('duplicate username (same email) → 409', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, password, name: 'Dup', setup_key: SETUP_KEY });
            assertJson(res);
            expect(res.status).toBe(409);
        });

        it('same email, different username → both created (201)', async () => {
            const sharedEmail = `shared-${uid()}@example.com`;
            const r1 = await request(app).post('/api/auth/create-user')
                .send({ email: sharedEmail, username: `ua-${uid()}`, name: 'User A', password, setup_key: SETUP_KEY });
            assertJson(r1);
            expect(r1.status).toBe(201);
            const r2 = await request(app).post('/api/auth/create-user')
                .send({ email: sharedEmail, username: `ub-${uid()}`, name: 'User B', password, setup_key: SETUP_KEY });
            assertJson(r2);
            expect(r2.status).toBe(201);
            expect(r1.body.data.email).toBe(sharedEmail);
            expect(r2.body.data.email).toBe(sharedEmail);
            expect(r1.body.data.username).not.toBe(r2.body.data.username);
        });

        it('missing password → 500 (bcrypt.hash throws)', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email: `np-${uid()}@t.com`, name: 'No Pass', setup_key: SETUP_KEY });
            assertJson(res);
            expect([400, 500]).toContain(res.status);
        });
    });

    // ── Step 2: login ─────────────────────────────────────────────────────────
    describe('POST /api/auth/login', () => {
        it('correct credentials → 200 with access + refresh tokens', async () => {
            const res = await request(app).post('/api/auth/login').send({ username: email, password });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.token).toBeTruthy();
            expect(res.body.refresh_token).toBeTruthy();
            expect(res.body.user.email).toBe(email);
            accessToken  = res.body.token;
            refreshToken = res.body.refresh_token;
        });

        it('access token carries type: access in payload', () => {
            const payload = jwt.decode(accessToken);
            expect(payload.type).toBe('access');
            expect(payload.email).toBe(email);
        });

        it('refresh token carries type: refresh in payload', () => {
            const payload = jwt.decode(refreshToken);
            expect(payload.type).toBe('refresh');
        });

        it('wrong password → 401 JSON', async () => {
            const res = await request(app).post('/api/auth/login')
                .send({ username: email, password: 'wrong-password' });
            assertJson(res);
            expect(res.status).toBe(401);
            expect(res.body).toHaveProperty('error');
        });

        it('unknown email → 401', async () => {
            const res = await request(app).post('/api/auth/login')
                .send({ username: 'nobody@example.com', password });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('empty body → 400', async () => {
            const res = await request(app).post('/api/auth/login').send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('missing password → 400', async () => {
            const res = await request(app).post('/api/auth/login').send({ username: email });
            assertJson(res);
            expect(res.status).toBe(400);
        });
    });

    // ── Step 3: refresh ───────────────────────────────────────────────────────
    describe('POST /api/auth/refresh', () => {
        it('valid refresh_token → 200 with new access + refresh tokens', async () => {
            const res = await request(app).post('/api/auth/refresh')
                .send({ refresh_token: refreshToken });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.token).toBeTruthy();
            expect(res.body.refresh_token).toBeTruthy();
        });

        it('using an access token as refresh_token → 401', async () => {
            const res = await request(app).post('/api/auth/refresh')
                .send({ refresh_token: accessToken });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('garbage token → 401', async () => {
            const res = await request(app).post('/api/auth/refresh')
                .send({ refresh_token: 'not.a.valid.token' });
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('missing refresh_token body → 400', async () => {
            const res = await request(app).post('/api/auth/refresh').send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });
    });

    // ── Step 4: logout ────────────────────────────────────────────────────────
    describe('POST /api/auth/logout', () => {
        it('always returns 200 (stateless)', async () => {
            const res = await request(app).post('/api/auth/logout');
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── Auth guard behaviors ──────────────────────────────────────────────────
    describe('auth guard edge cases', () => {
        it('using refresh token as Bearer for protected route → 401', async () => {
            const res = await request(app).get('/api/admin/users')
                .set('Authorization', `Bearer ${refreshToken}`);
            assertJson(res);
            expect(res.status).toBe(401);
            expect(res.body).toHaveProperty('error');
        });

        it('invalid Bearer token → 401 JSON', async () => {
            const res = await request(app).get('/api/admin/users')
                .set('Authorization', 'Bearer garbage.token.value');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('no Authorization header → 401', async () => {
            const res = await request(app).get('/api/admin/users');
            assertJson(res);
            expect(res.status).toBe(401);
        });

        it('malformed Authorization header (no Bearer prefix) → 401', async () => {
            const res = await request(app).get('/api/admin/users')
                .set('Authorization', accessToken);
            assertJson(res);
            expect(res.status).toBe(401);
        });
    });

    // ── Google OAuth stubs ────────────────────────────────────────────────────
    describe('POST /api/auth/google/exchange', () => {
        it('missing params → 400 JSON', async () => {
            const res = await request(app).post('/api/auth/google/exchange').send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });
    });

    // ── SSO endpoint ──────────────────────────────────────────────────────────
    describe('POST /api/auth/sso/issue', () => {
        it('no auth → 401 JSON', async () => {
            const res = await request(app).post('/api/auth/sso/issue').send({ aud: 'rohas' });
            assertJson(res);
            expect(res.status).toBe(401);
        });
    });
});
