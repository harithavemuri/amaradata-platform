// @vitest-environment node

/**
 * server.js's x-origin-secret gate — blocks direct API Gateway hits that
 * bypass CloudFront (see template.yaml's CloudFront OriginCustomHeaders and
 * feedback: this is a live, actively-enforced production control, not dead
 * code — verified against the deployed amaradata-prod-api Lambda and the
 * EVRE22H489D0P CloudFront distribution).
 *
 * This had never been exercised by any test before: no other test file sets
 * ORIGIN_SECRET, so the `if (process.env.ORIGIN_SECRET || ORIGIN_SECRET_ID)`
 * gate in server.js is always false everywhere else and the middleware is
 * simply never registered. This file sets ORIGIN_SECRET before requiring
 * server.js specifically so the gate activates for these tests only — each
 * vitest test file gets its own isolated module graph, so this doesn't affect
 * any other test file's copy of server.js/app.
 *
 * services/secrets.js is stubbed via createRequire (not vi.mock() — see
 * project convention in auth-secret-retry.test.js / email-routes.test.js:
 * vi.mock() does not reliably intercept require() calls nested inside
 * another CJS module's own require graph) so the retry-on-mismatch path is
 * actually observable instead of always resolving the same static fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

process.env.ORIGIN_SECRET = 'test-origin-secret-value';

const require_       = createRequire(import.meta.url);
const secretsModule  = require_('../../backend/services/secrets.js');

const getSecret  = vi.fn();
const invalidate = vi.fn();
secretsModule.getSecret  = getSecret;
secretsModule.invalidate = invalidate;

// Required after stubbing services/secrets.js so server.js's own
// `require('./backend/services/secrets')` resolves to the same stubbed object.
const app = require_('../../server.js');

const CORRECT  = 'test-origin-secret-value';
const STALE    = 'stale-cached-value';

beforeEach(() => {
    getSecret.mockReset();
    invalidate.mockReset();
});

describe('origin-secret gate (server.js)', () => {
    it('passes a request whose header matches the resolved secret, without invalidating', async () => {
        getSecret.mockResolvedValue(CORRECT);

        const res = await request(app)
            .post('/api/auth/login')
            .set('x-origin-secret', CORRECT)
            .send({});

        expect(res.status).not.toBe(403);   // reaches the route (400: missing username/password)
        expect(res.status).toBe(400);
        expect(getSecret).toHaveBeenCalledTimes(1);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('recovers when the header was minted against a newer secret than this instance has cached', async () => {
        // Simulates: this instance still has a stale cached secret, but
        // CloudFront (or whatever set the header) already has the current one.
        getSecret.mockResolvedValueOnce(STALE).mockResolvedValueOnce(CORRECT);

        const res = await request(app)
            .post('/api/auth/login')
            .set('x-origin-secret', CORRECT)
            .send({});

        expect(res.status).toBe(400);   // gate passed, reached the route
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(getSecret).toHaveBeenCalledTimes(2);
    });

    it('invalidates before retrying, not after — the retry must compare against a fresh secret', async () => {
        const order = [];
        getSecret
            .mockImplementationOnce(async () => { order.push('fetch-1'); return STALE; })
            .mockImplementationOnce(async () => { order.push('fetch-2'); return CORRECT; });
        invalidate.mockImplementation(() => { order.push('invalidate'); });

        await request(app).post('/api/auth/login').set('x-origin-secret', CORRECT).send({});
        expect(order).toEqual(['fetch-1', 'invalidate', 'fetch-2']);
    });

    it('rejects with 403 when the header is wrong even after one retry', async () => {
        getSecret.mockResolvedValue(CORRECT);

        const res = await request(app)
            .post('/api/auth/login')
            .set('x-origin-secret', 'totally-wrong')
            .send({});

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
        expect(getSecret).toHaveBeenCalledTimes(2);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it('rejects with 403 when the header is missing entirely', async () => {
        getSecret.mockResolvedValue(CORRECT);

        const res = await request(app).post('/api/auth/login').send({});
        expect(res.status).toBe(403);
    });

    it('exempts /health regardless of header, and never calls getSecret', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(getSecret).not.toHaveBeenCalled();
    });

    it('exempts /api/site-config regardless of header, and never calls getSecret', async () => {
        const res = await request(app).get('/api/site-config');
        expect(res.status).toBe(200);
        expect(getSecret).not.toHaveBeenCalled();
    });
});
