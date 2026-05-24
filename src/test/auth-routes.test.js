// @vitest-environment node

/**
 * Auth route contract tests — run before every deploy.
 *
 * Guards against the CloudFront CustomErrorResponses bug where a 403 from
 * the origin-secret check gets rewritten to 200 + login.html, causing
 * "Unexpected token '<'" on the client when it calls res.json().
 *
 * Rule: every /api/* response MUST carry Content-Type: application/json.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
// setup.js sets NONDB_MODE=true before this import resolves
import app from '../../server.js';

function assertJson(res) {
    const ct = res.headers['content-type'] || '';
    expect(ct, `Expected JSON content-type but got: "${ct}"`).toMatch(/application\/json/);
    const text = JSON.stringify(res.body);
    expect(text, 'Response body must not contain HTML').not.toContain('<!DOCTYPE');
}

describe('Auth routes — always return JSON, never HTML', () => {
    it('POST /api/auth/login with bad credentials → 401 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'nobody@test.com', password: 'wrong' });
        assertJson(res);
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty('error');
    });

    it('POST /api/auth/login with empty body → 400 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({});
        assertJson(res);
        expect(res.status).toBe(400);
    });

    it('POST /api/auth/refresh with missing token → 400 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/refresh')
            .send({});
        assertJson(res);
        expect(res.status).toBe(400);
    });

    it('POST /api/auth/refresh with invalid token → 401 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/refresh')
            .send({ refresh_token: 'not.a.real.token' });
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('POST /api/auth/google/exchange with missing params → 400 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/google/exchange')
            .send({});
        assertJson(res);
        expect(res.status).toBe(400);
    });

    it('GET /api/unknown-route → 404 JSON, not login.html', async () => {
        const res = await request(app).get('/api/this-does-not-exist');
        assertJson(res);
        expect(res.status).toBe(404);
    });

    it('POST /api/unknown-route → 404 JSON, not login.html', async () => {
        const res = await request(app)
            .post('/api/this-does-not-exist')
            .send({});
        assertJson(res);
        expect(res.status).toBe(404);
    });

    it('Origin-secret check → JSON error (not HTML that CloudFront could swallow)', async () => {
        // The middleware registers once at startup based on whether ORIGIN_SECRET
        // is set. Regardless of whether it fires (403) or falls through to the
        // route handler (401 for bad creds), the response MUST be JSON — never HTML.
        const res = await request(app)
            .post('/api/auth/login')
            .set('x-origin-secret', 'wrong-secret')
            .send({ email: 'test@test.com', password: 'pw' });
        assertJson(res);
        expect([401, 403]).toContain(res.status);
    });

    // ── SSO issuer ───────────────────────────────────────────────────────────
    it('POST /api/auth/sso/issue without auth → 401 JSON', async () => {
        const res = await request(app)
            .post('/api/auth/sso/issue')
            .send({ aud: 'rohas' });
        assertJson(res);
        expect(res.status).toBe(401);
    });

    // ── Admin routes ─────────────────────────────────────────────────────────
    it('GET /api/admin/users without auth → 401 JSON', async () => {
        const res = await request(app).get('/api/admin/users');
        assertJson(res);
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/user-groups without auth → 401 JSON', async () => {
        const res = await request(app).get('/api/admin/user-groups');
        assertJson(res);
        expect(res.status).toBe(401);
    });
});
