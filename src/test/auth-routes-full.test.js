// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../server.js';
import { uid, tokens, auth } from './helpers.js';

const SETUP_KEY = 'test-jwt-secret-32-chars-minimum!!';

describe('Auth routes — full coverage', () => {
    // ── create-user ──────────────────────────────────────────────────────────
    describe('POST /api/auth/create-user', () => {
        it('without setup_key → 403', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email: `u${uid()}@t.com`, name: 'Test', password: 'pass1234' });
            expect(res.status).toBe(403);
            expect(res.headers['content-type']).toMatch(/json/);
            expect(res.body).toHaveProperty('error');
        });

        it('with valid setup_key → 201', async () => {
            const email = `user-${uid()}@test.com`;
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Test User', password: 'pass1234', setup_key: SETUP_KEY });
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.email).toBe(email);
            expect(res.body.data).not.toHaveProperty('password_hash');
        });

        it('duplicate email → 409', async () => {
            const email = `dup-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'First', password: 'pass1234', setup_key: SETUP_KEY });
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Second', password: 'pass1234', setup_key: SETUP_KEY });
            expect(res.status).toBe(409);
        });
    });

    // ── login ────────────────────────────────────────────────────────────────
    describe('POST /api/auth/login — success', () => {
        let email;
        beforeAll(async () => {
            email = `login-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Login User', password: 'correctpassword', setup_key: SETUP_KEY });
        });

        it('correct credentials → 200 with token and refresh_token', async () => {
            const res = await request(app).post('/api/auth/login')
                .send({ email, password: 'correctpassword' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('token');
            expect(res.body).toHaveProperty('refresh_token');
            expect(res.body.user).toHaveProperty('email', email);
            expect(res.body.user).not.toHaveProperty('password_hash');
        });
    });

    // ── refresh ──────────────────────────────────────────────────────────────
    describe('POST /api/auth/refresh — success', () => {
        it('valid refresh_token → 200 with new token', async () => {
            const email = `refresh-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Refresh User', password: 'pass1234', setup_key: SETUP_KEY });
            const login = await request(app).post('/api/auth/login')
                .send({ email, password: 'pass1234' });
            const refreshToken = login.body.refresh_token;

            const res = await request(app).post('/api/auth/refresh')
                .send({ refresh_token: refreshToken });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('token');
        });
    });

    // ── logout ───────────────────────────────────────────────────────────────
    describe('POST /api/auth/logout', () => {
        it('always → 200', async () => {
            const res = await request(app).post('/api/auth/logout');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── forgot-password ──────────────────────────────────────────────────────
    describe('POST /api/auth/forgot-password', () => {
        it('missing email → 400', async () => {
            const res = await request(app).post('/api/auth/forgot-password').send({});
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('unknown email → 200 (no user enumeration)', async () => {
            const res = await request(app).post('/api/auth/forgot-password')
                .send({ email: 'nobody@nonexistent.com' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('registered email with password → 200', async () => {
            const email = `fp-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'FP User', password: 'pass1234', setup_key: SETUP_KEY });
            const res = await request(app).post('/api/auth/forgot-password').send({ email });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── reset-password ───────────────────────────────────────────────────────
    describe('POST /api/auth/reset-password', () => {
        it('missing token and password → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password').send({});
            expect(res.status).toBe(400);
        });

        it('password too short → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password')
                .send({ token: 'anytoken', password: 'short' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/8 characters/);
        });

        it('invalid token → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password')
                .send({ token: 'invalid-token-xyz', password: 'validpassword123' });
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });
    });

    // ── sso/issue ────────────────────────────────────────────────────────────
    describe('POST /api/auth/sso/issue', () => {
        it('with valid auth but missing aud → 400', async () => {
            const res = await request(app).post('/api/auth/sso/issue')
                .set(auth('admin'))
                .send({});
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('with valid auth and aud → 200', async () => {
            const res = await request(app).post('/api/auth/sso/issue')
                .set(auth('admin'))
                .send({ aud: 'rohas' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('sso_token');
        });
    });

    // ── google/login ─────────────────────────────────────────────────────────
    describe('POST /api/auth/google/login', () => {
        it('→ 200 with PKCE session data', async () => {
            const res = await request(app).post('/api/auth/google/login').send({});
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveProperty('sessionId');
            expect(res.body.data).toHaveProperty('authUrl');
        });
    });

    // ── google/callback ──────────────────────────────────────────────────────
    describe('GET /api/auth/google/callback', () => {
        it('missing code/state → redirect to login with error', async () => {
            const res = await request(app).get('/api/auth/google/callback');
            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('/login');
        });

        it('with error param → redirect with that error', async () => {
            const res = await request(app).get('/api/auth/google/callback?error=access_denied');
            expect(res.status).toBe(302);
            expect(res.headers.location).toContain('access_denied');
        });
    });
});
