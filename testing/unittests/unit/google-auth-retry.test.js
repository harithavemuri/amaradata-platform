// @vitest-environment node
/**
 * backend/auth/google-auth.js — exchangeCode()'s retry-on-invalid_client.
 *
 * GOOGLE_CLIENT_SECRET is now resolved at runtime through services/secrets.js's
 * cache (see project-realtime-secret-fetch-standard.md), not baked into the
 * Lambda env at deploy time. Google returns error: "invalid_client" for a wrong
 * client secret — that could be a genuinely wrong value, or this instance's
 * cache being stale mid a rotation, indistinguishable from the response alone.
 * exchangeCode() invalidates the cached secret and retries the token exchange
 * exactly once with a freshly fetched value before giving up.
 *
 * _request() (the actual https call to Google) is stubbed via vi.spyOn on the
 * prototype — no real network call is made. services/secrets.js is stubbed via
 * createRequire, not vi.mock() (see project convention in auth-secret-retry.test.js:
 * vi.mock() does not reliably intercept require() calls nested inside another
 * CJS module's own require graph).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_       = createRequire(import.meta.url);
const secretsModule  = require_('../../../backend/services/secrets.js');
const GoogleOAuth    = require_('../../../backend/auth/google-auth.js');

const getSecret  = vi.fn();
const invalidate = vi.fn();
secretsModule.getSecret  = getSecret;
secretsModule.invalidate = invalidate;

const OLD_SECRET = 'old-client-secret-before-rotation';
const NEW_SECRET = 'new-client-secret-after-rotation';

/** Pull client_secret back out of the x-www-form-urlencoded request body _request() was called with. */
function clientSecretFromCall(call) {
    const [, body] = call;
    return new URLSearchParams(body).get('client_secret');
}

beforeEach(() => {
    getSecret.mockReset();
    invalidate.mockReset();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    vi.restoreAllMocks();
});

describe('exchangeCode retry-on-invalid_client', () => {
    it('succeeds on the first try with the resolved secret and never invalidates', async () => {
        getSecret.mockResolvedValue(OLD_SECRET);
        const requestSpy = vi.spyOn(GoogleOAuth.prototype, '_request')
            .mockResolvedValue({ access_token: 'tok', token_type: 'Bearer' });

        const auth = new GoogleOAuth();
        const data = await auth.exchangeCode('code123', 'verifier123');

        expect(data.access_token).toBe('tok');
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(clientSecretFromCall(requestSpy.mock.calls[0])).toBe(OLD_SECRET);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('recovers when a stale cached secret gets invalid_client, retrying with a fresh one', async () => {
        getSecret.mockResolvedValueOnce(OLD_SECRET).mockResolvedValueOnce(NEW_SECRET);
        const requestSpy = vi.spyOn(GoogleOAuth.prototype, '_request')
            .mockResolvedValueOnce({ error: 'invalid_client', error_description: 'The OAuth client was not found.' })
            .mockResolvedValueOnce({ access_token: 'tok-after-retry', token_type: 'Bearer' });

        const auth = new GoogleOAuth();
        const data = await auth.exchangeCode('code123', 'verifier123');

        expect(data.access_token).toBe('tok-after-retry');
        expect(requestSpy).toHaveBeenCalledTimes(2);
        expect(clientSecretFromCall(requestSpy.mock.calls[0])).toBe(OLD_SECRET);
        expect(clientSecretFromCall(requestSpy.mock.calls[1])).toBe(NEW_SECRET);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it('invalidates before retrying, not after — the retry must use a fresh secret', async () => {
        const order = [];
        getSecret
            .mockImplementationOnce(async () => { order.push('fetch-1'); return OLD_SECRET; })
            .mockImplementationOnce(async () => { order.push('fetch-2'); return NEW_SECRET; });
        invalidate.mockImplementation(() => { order.push('invalidate'); });
        vi.spyOn(GoogleOAuth.prototype, '_request')
            .mockImplementationOnce(async () => { order.push('request-1'); return { error: 'invalid_client' }; })
            .mockImplementationOnce(async () => { order.push('request-2'); return { access_token: 'tok' }; });

        const auth = new GoogleOAuth();
        await auth.exchangeCode('code123', 'verifier123');
        expect(order).toEqual(['fetch-1', 'request-1', 'invalidate', 'fetch-2', 'request-2']);
    });

    it('gives up after one retry and throws when invalid_client persists', async () => {
        getSecret.mockResolvedValue(OLD_SECRET);
        const requestSpy = vi.spyOn(GoogleOAuth.prototype, '_request')
            .mockResolvedValue({ error: 'invalid_client', error_description: 'The OAuth client was not found.' });

        const auth = new GoogleOAuth();
        await expect(auth.exchangeCode('code123', 'verifier123')).rejects.toThrow('The OAuth client was not found.');
        expect(requestSpy).toHaveBeenCalledTimes(2);
        expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it('does not retry a non-invalid_client error (e.g. a bad/expired auth code)', async () => {
        getSecret.mockResolvedValue(OLD_SECRET);
        const requestSpy = vi.spyOn(GoogleOAuth.prototype, '_request')
            .mockResolvedValue({ error: 'invalid_grant', error_description: 'Malformed auth code.' });

        const auth = new GoogleOAuth();
        await expect(auth.exchangeCode('bad-code', 'verifier123')).rejects.toThrow('Malformed auth code.');
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(invalidate).not.toHaveBeenCalled();
    });
});
