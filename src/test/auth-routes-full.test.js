// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import app from '../../server.js';
import { uid, tokens, auth, assertJson } from './helpers.js';

// vi.mock() doesn't reliably intercept require('../auth/google-auth') nested
// inside server.js's own CJS require graph (same issue documented in
// src/test/email-routes.test.js). createRequire reaches the exact same class
// auth.js's require() sees, so patching its prototype methods reaches every
// `new GoogleOAuth()` the route handler creates, regardless of which
// "copy" of the require graph constructed it.
const _require  = createRequire(import.meta.url);
const GoogleOAuth = _require('../../backend/auth/google-auth.js');

const SETUP_KEY = 'test-jwt-secret-32-chars-minimum!!';

describe('Auth routes — full coverage', () => {
    // ── create-user ──────────────────────────────────────────────────────────
    describe('POST /api/auth/create-user', () => {
        it('without setup_key → 403', async () => {
            const res = await request(app).post('/api/auth/create-user')
                .send({ email: `u${uid()}@t.com`, name: 'Test', password: 'pass1234' });
            assertJson(res);
            expect(res.status).toBe(403);
            expect(res.body).toHaveProperty('error');
        });

        it('with valid setup_key → 201', async () => {
            const email = `user-${uid()}@test.com`;
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Test User', password: 'pass1234', setup_key: SETUP_KEY });
            assertJson(res);
            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.data.email).toBe(email);
            expect(res.body.data).not.toHaveProperty('password_hash');
        });

        it('duplicate username → 409', async () => {
            const email = `dup-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'First', password: 'pass1234', setup_key: SETUP_KEY });
            const res = await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Second', password: 'pass1234', setup_key: SETUP_KEY });
            assertJson(res);
            expect(res.status).toBe(409);
        });

        it('same email, different username → both created (201)', async () => {
            const sharedEmail = `shared-${uid()}@test.com`;
            const res1 = await request(app).post('/api/auth/create-user')
                .send({ email: sharedEmail, username: `u1-${uid()}`, name: 'User One', password: 'pass1234', setup_key: SETUP_KEY });
            assertJson(res1);
            expect(res1.status).toBe(201);
            const res2 = await request(app).post('/api/auth/create-user')
                .send({ email: sharedEmail, username: `u2-${uid()}`, name: 'User Two', password: 'pass1234', setup_key: SETUP_KEY });
            assertJson(res2);
            expect(res2.status).toBe(201);
            expect(res1.body.data.email).toBe(sharedEmail);
            expect(res2.body.data.email).toBe(sharedEmail);
            expect(res1.body.data.username).not.toBe(res2.body.data.username);
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
                .send({ username: email, password: 'correctpassword' });
            assertJson(res);
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
                .send({ username: email, password: 'pass1234' });
            const refreshToken = login.body.refresh_token;

            const res = await request(app).post('/api/auth/refresh')
                .send({ refresh_token: refreshToken });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('token');
        });
    });

    // ── logout ───────────────────────────────────────────────────────────────
    describe('POST /api/auth/logout', () => {
        it('always → 200', async () => {
            const res = await request(app).post('/api/auth/logout');
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── forgot-password ──────────────────────────────────────────────────────
    describe('POST /api/auth/forgot-password', () => {
        it('missing email → 400', async () => {
            const res = await request(app).post('/api/auth/forgot-password').send({});
            assertJson(res);
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('unknown email → 200 (no user enumeration)', async () => {
            const res = await request(app).post('/api/auth/forgot-password')
                .send({ email: 'nobody@nonexistent.com' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('registered email with password → 200', async () => {
            const email = `fp-${uid()}@test.com`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'FP User', password: 'pass1234', setup_key: SETUP_KEY });
            const res = await request(app).post('/api/auth/forgot-password').send({ email });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ── reset-password ───────────────────────────────────────────────────────
    describe('POST /api/auth/reset-password', () => {
        it('missing token and password → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password').send({});
            assertJson(res);
            expect(res.status).toBe(400);
        });

        it('password too short → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password')
                .send({ token: 'anytoken', password: 'short' });
            assertJson(res);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/8 characters/);
        });

        it('invalid token → 400', async () => {
            const res = await request(app).post('/api/auth/reset-password')
                .send({ token: 'invalid-token-xyz', password: 'validpassword123' });
            assertJson(res);
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
            assertJson(res);
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('error');
        });

        it('with valid auth and aud → 200', async () => {
            const res = await request(app).post('/api/auth/sso/issue')
                .set(auth('admin'))
                .send({ aud: 'rohas' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('sso_token');
        });
    });

    // ── google/login ─────────────────────────────────────────────────────────
    describe('POST /api/auth/google/login', () => {
        it('→ 200 with PKCE session data', async () => {
            const res = await request(app).post('/api/auth/google/login').send({});
            assertJson(res);
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

    // ── google/exchange — success ────────────────────────────────────────────
    // Regression coverage for a real production bug: the exchange handler's
    // raw SQL wrote to a `picture` column that migration 2026.06.12.001
    // dropped (consolidated into `logo_url` by an earlier migration), so
    // every real Google login 500'd right after the user approved consent.
    // GoogleOAuth's exchangeCode()/getUserInfo() make real HTTPS calls to
    // Google — mocked here so this exercises the actual DB write path.
    describe('POST /api/auth/google/exchange — success', () => {
        afterEach(() => vi.restoreAllMocks());

        function mockGoogleUser(userInfo) {
            vi.spyOn(GoogleOAuth.prototype, 'exchangeCode').mockResolvedValue({ access_token: 'fake-token' });
            vi.spyOn(GoogleOAuth.prototype, 'getUserInfo').mockResolvedValue(userInfo);
        }

        it('new user → 200, creates the user with logo_url set from Google picture', async () => {
            const email = `zzzzzz.google.${uid()}@test.local`;
            mockGoogleUser({ id: `g-${uid()}`, email, name: 'Google User', picture: 'https://example.com/pic.jpg' });

            const res = await request(app).post('/api/auth/google/exchange')
                .send({ code: 'fake-code', state: 'sess:csrf', code_verifier: 'fake-verifier' });
            assertJson(res);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.user.email).toBe(email);
            expect(res.body.data.token).toBeTruthy();

            const users = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            const created = users.body.data.find(u => u.email === email);
            expect(created, 'expected the Google-created user to exist via the admin API').toBeTruthy();
            expect(created.logo_url).toBe('https://example.com/pic.jpg');
        });

        it('existing user (matched by email) → 200, updates logo_url and google_id', async () => {
            const email = `zzzzzz.google.existing.${uid()}@test.local`;
            await request(app).post('/api/auth/create-user')
                .send({ email, name: 'Existing User', password: 'pass1234', setup_key: SETUP_KEY });

            const googleId = `g-${uid()}`;
            mockGoogleUser({ id: googleId, email, name: 'Existing User', picture: 'https://example.com/new-pic.jpg' });

            const res = await request(app).post('/api/auth/google/exchange')
                .send({ code: 'fake-code', state: 'sess:csrf', code_verifier: 'fake-verifier' });
            assertJson(res);
            expect(res.status).toBe(200);

            const users    = await request(app).get('/api/admin/users').set(auth('siteAdmin'));
            const existing = users.body.data.find(u => u.email === email);
            expect(existing.logo_url).toBe('https://example.com/new-pic.jpg');
        });
    });
});
