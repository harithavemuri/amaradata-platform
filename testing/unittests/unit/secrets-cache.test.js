// @ts-check
/**
 * backend/services/secrets.js — cached Secrets Manager reader.
 *
 * Exists so DB credentials can be rotated without a redeploy: the pg pools ask
 * for the password per-connection via a function, this module serves it from a
 * short-TTL in-memory cache, so a rotated secret is picked up within one TTL
 * instead of requiring CloudFormation to re-resolve a baked env var.
 *
 * Caching matters for cost as much as latency — an uncached GetSecretValue on
 * every pool connection would bill per API call on a hot path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

// vi.mock() does not intercept a require() nested inside a CJS module's own
// function body — the factory silently never runs (same gotcha documented in
// CLAUDE.md for email-routes.test.js). Reach the exact module object that
// secrets.js's require() resolves to, and patch the client class on it.
// GetSecretValueCommand is left real: the genuine command object already
// exposes its payload as `.input`, which is what the assertion below reads.
const require_ = createRequire(import.meta.url);
const sdk      = require_('@aws-sdk/client-secrets-manager');

const send = vi.fn();
sdk.SecretsManagerClient = class { send = send; };

let secrets;

beforeEach(async () => {
    vi.resetModules();          // fresh module → its memoized client is null again
    send.mockReset();
    process.env.SECRET_CACHE_TTL_MS = '300000';
    secrets = await import('../../../backend/services/secrets.js');
    secrets.clearCache();
});

describe('getSecret — fetching', () => {
    it('returns the trimmed SecretString from Secrets Manager', async () => {
        send.mockResolvedValue({ SecretString: '  hunter2\n' });
        expect(await secrets.getSecret('/amaradata/prod/db-write-password')).toBe('hunter2');
    });

    it('passes the secret id through to GetSecretValueCommand', async () => {
        send.mockResolvedValue({ SecretString: 'x' });
        await secrets.getSecret('/some/secret');
        expect(send.mock.calls[0][0].input).toEqual({ SecretId: '/some/secret' });
    });
});

describe('getSecret — caching', () => {
    it('only calls Secrets Manager once for repeated reads within the TTL', async () => {
        send.mockResolvedValue({ SecretString: 'cached-value' });

        const a = await secrets.getSecret('/repeat');
        const b = await secrets.getSecret('/repeat');
        const c = await secrets.getSecret('/repeat');

        expect([a, b, c]).toEqual(['cached-value', 'cached-value', 'cached-value']);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('refetches once the TTL has expired — this is what makes a rotation take effect', async () => {
        vi.useFakeTimers();
        try {
            send.mockResolvedValueOnce({ SecretString: 'old-password' })
                .mockResolvedValueOnce({ SecretString: 'rotated-password' });

            expect(await secrets.getSecret('/rotating')).toBe('old-password');

            vi.advanceTimersByTime(300_001);

            expect(await secrets.getSecret('/rotating')).toBe('rotated-password');
            expect(send).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('caches each secret id independently', async () => {
        send.mockResolvedValueOnce({ SecretString: 'write-pw' })
            .mockResolvedValueOnce({ SecretString: 'read-pw' });

        expect(await secrets.getSecret('/write')).toBe('write-pw');
        expect(await secrets.getSecret('/read')).toBe('read-pw');
        expect(await secrets.getSecret('/write')).toBe('write-pw');
        expect(send).toHaveBeenCalledTimes(2);
    });
});

describe('invalidate — the rotation recovery path', () => {
    it('drops a single secret so the next read refetches it', async () => {
        send.mockResolvedValueOnce({ SecretString: 'old-password' })
            .mockResolvedValueOnce({ SecretString: 'rotated-password' });

        expect(await secrets.getSecret('/rotating')).toBe('old-password');
        secrets.invalidate('/rotating');
        expect(await secrets.getSecret('/rotating')).toBe('rotated-password');
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('leaves other cached secrets alone', async () => {
        send.mockResolvedValueOnce({ SecretString: 'write-pw' })
            .mockResolvedValueOnce({ SecretString: 'read-pw' })
            .mockResolvedValueOnce({ SecretString: 'write-pw-2' });

        await secrets.getSecret('/write');
        await secrets.getSecret('/read');

        secrets.invalidate('/write');

        expect(await secrets.getSecret('/write')).toBe('write-pw-2'); // refetched
        expect(await secrets.getSecret('/read')).toBe('read-pw');     // still cached
        expect(send).toHaveBeenCalledTimes(3);
    });
});

describe('getSecret — concurrent fetch de-duplication', () => {
    // Cost control: an auth failure under load invalidates the cache, and every
    // in-flight connection then asks for the password at once. Without de-duping,
    // that is one billed GetSecretValue call per connection.
    it('collapses concurrent misses for the same secret into one API call', async () => {
        let release;
        send.mockImplementation(() => new Promise(res => {
            release = () => res({ SecretString: 'shared-value' });
        }));

        const inFlight = Promise.all([
            secrets.getSecret('/hot'), secrets.getSecret('/hot'),
            secrets.getSecret('/hot'), secrets.getSecret('/hot'),
        ]);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        release();

        expect(await inFlight).toEqual(
            ['shared-value', 'shared-value', 'shared-value', 'shared-value']);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('still issues separate calls for different secrets', async () => {
        send.mockResolvedValue({ SecretString: 'v' });
        await Promise.all([secrets.getSecret('/a'), secrets.getSecret('/b')]);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rejected fetch — the next call retries', async () => {
        send.mockRejectedValueOnce(new Error('ThrottlingException'))
            .mockResolvedValueOnce({ SecretString: 'recovered' });

        await expect(secrets.getSecret('/transient')).rejects.toThrow('ThrottlingException');
        expect(await secrets.getSecret('/transient')).toBe('recovered');
    });
});

describe('getSecret — fallback behavior', () => {
    it('returns the fallback without calling AWS when no secret id is configured', async () => {
        expect(await secrets.getSecret('', { fallback: 'env-var-password' })).toBe('env-var-password');
        expect(await secrets.getSecret(undefined, { fallback: 'env-var-password' })).toBe('env-var-password');
        expect(send).not.toHaveBeenCalled();
    });

    it('falls back to the env-var value when the fetch fails and nothing is cached', async () => {
        send.mockRejectedValue(new Error('AccessDeniedException'));
        expect(await secrets.getSecret('/broken', { fallback: 'env-var-password' })).toBe('env-var-password');
    });

    it('serves a stale cached value when a refetch fails — a Secrets Manager blip must not take the DB down', async () => {
        vi.useFakeTimers();
        try {
            send.mockResolvedValueOnce({ SecretString: 'good-password' })
                .mockRejectedValueOnce(new Error('ThrottlingException'));

            expect(await secrets.getSecret('/flaky')).toBe('good-password');
            vi.advanceTimersByTime(300_001);
            expect(await secrets.getSecret('/flaky')).toBe('good-password');
        } finally {
            vi.useRealTimers();
        }
    });

    it('rethrows when the fetch fails with no cache and no fallback', async () => {
        send.mockRejectedValue(new Error('ResourceNotFoundException'));
        await expect(secrets.getSecret('/missing')).rejects.toThrow('ResourceNotFoundException');
    });
});
