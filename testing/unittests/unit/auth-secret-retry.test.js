// @vitest-environment node
/**
 * backend/middleware/auth.js — verifyWithRetry().
 *
 * JWT secrets are now resolved at runtime through services/secrets.js's cache
 * (see project-realtime-secret-fetch-standard.md), not baked into the Lambda
 * env at deploy time. Different concurrent Lambda execution environments each
 * hold their own independent in-memory cache, so during a rotation window one
 * instance can still be signing/verifying with the old secret while another has
 * already refreshed — a token minted by the fresher instance then fails to
 * verify on the stale one, looking exactly like a bad token.
 *
 * verifyWithRetry() covers that race: on a verify failure it invalidates the
 * cached secret and retries exactly once with a freshly fetched value before
 * giving up. services/secrets.js is mocked here so the retry path is actually
 * observable — with no AMRD_JWT_SECRET_ID configured, getSecret() always
 * resolves to the same static fallback and the retry would be a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

// vi.mock() does not reliably intercept require() calls nested inside another
// CJS module's own require graph (same gotcha documented for src/test/email-routes.test.js
// against backend/services/email-s3-client.js) — auth.js's internal
// `require('../services/secrets')` call is exactly that case. createRequire()
// reaches the identical module object auth.js's require() resolves to, so
// overwriting its exports directly actually takes effect — auth.js reads
// secrets.getSecret/secrets.invalidate via property access, not a destructured
// local binding, specifically so this works.
const require_      = createRequire(import.meta.url);
const secretsModule = require_('../../../backend/services/secrets.js');
const { verifyWithRetry } = require_('../../../backend/middleware/auth.js');

const getSecret  = vi.fn();
const invalidate = vi.fn();
secretsModule.getSecret  = getSecret;
secretsModule.invalidate = invalidate;

const OLD_SECRET = 'old-secret-before-rotation';
const NEW_SECRET = 'new-secret-after-rotation';

beforeEach(() => {
    getSecret.mockReset();
    invalidate.mockReset();
});

describe('verifyWithRetry', () => {
    it('verifies successfully with the cached secret and never invalidates', async () => {
        getSecret.mockResolvedValue(OLD_SECRET);
        const token = jwt.sign({ id: 1, type: 'access' }, OLD_SECRET);

        const payload = await verifyWithRetry(token);
        expect(payload.id).toBe(1);
        expect(getSecret).toHaveBeenCalledTimes(1);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('recovers when a token signed under a newer secret fails against a stale cache', async () => {
        // Simulates: this instance still has OLD_SECRET cached, but the token was
        // signed elsewhere after rotation, under NEW_SECRET.
        getSecret.mockResolvedValueOnce(OLD_SECRET).mockResolvedValueOnce(NEW_SECRET);
        const token = jwt.sign({ id: 7, type: 'access' }, NEW_SECRET);

        const payload = await verifyWithRetry(token);
        expect(payload.id).toBe(7);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(getSecret).toHaveBeenCalledTimes(2);
    });

    it('invalidates before retrying, not after — the retry must use a fresh secret', async () => {
        const order = [];
        getSecret
            .mockImplementationOnce(async () => { order.push('fetch-1'); return OLD_SECRET; })
            .mockImplementationOnce(async () => { order.push('fetch-2'); return NEW_SECRET; });
        invalidate.mockImplementation(() => { order.push('invalidate'); });
        const token = jwt.sign({ id: 1, type: 'access' }, NEW_SECRET);

        await verifyWithRetry(token);
        expect(order).toEqual(['fetch-1', 'invalidate', 'fetch-2']);
    });

    it('gives up after one retry and throws for a token that is genuinely invalid', async () => {
        getSecret.mockResolvedValue(OLD_SECRET);
        const forged = jwt.sign({ id: 1, type: 'access' }, 'some-other-secret-entirely');

        await expect(verifyWithRetry(forged)).rejects.toThrow();
        expect(getSecret).toHaveBeenCalledTimes(2);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });
});
