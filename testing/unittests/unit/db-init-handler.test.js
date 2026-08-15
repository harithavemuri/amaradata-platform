// @vitest-environment node
/**
 * backend/lambda/db-init.js — the DBInitFn handler's own wiring (pool config,
 * schema loading, and its withConnectRetry integration), not just the
 * extracted retry helper (already covered by db-connect-retry.test.js).
 *
 * pg's Pool.prototype.query/end are spied on directly (not the module's
 * destructured `Pool` binding) so the mock applies regardless of how db-init.js
 * obtained its reference to the class — prototype method lookup happens per
 * call via the prototype chain, unlike the destructured-function-reference
 * problem documented in auth-secret-retry.test.js.
 *
 * withConnectRetry's default backoff uses real setTimeout, so fake timers are
 * required to keep the retry-path tests fast instead of actually waiting 5s/10s.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { Pool }  = require_('pg');
const { handler } = require_('../../../backend/lambda/db-init.js');

const netError = (code) => Object.assign(new Error(`connect ${code}`), { code });

beforeEach(() => {
    process.env.AMRD_DB_HOST         = 'test-host';
    process.env.AMRD_DB_NAME         = 'test-db';
    process.env.AMRD_DB_WRITE_USER   = 'test-user';
    process.env.AMRD_DB_WRITE_PASSWORD = 'test-password';
    vi.spyOn(Pool.prototype, 'end').mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('db-init handler', () => {
    it('returns 200 and closes the pool on a clean first-try schema load', async () => {
        const querySpy = vi.spyOn(Pool.prototype, 'query').mockResolvedValue({});

        const res = await handler();
        expect(res).toEqual({ statusCode: 200, body: JSON.stringify({ success: true }) });
        expect(querySpy).toHaveBeenCalledTimes(1);
        expect(Pool.prototype.end).toHaveBeenCalledTimes(1);
    });

    it('does not retry a non-connectivity error (e.g. a real SQL error) — fails fast', async () => {
        const sqlErr = Object.assign(new Error('syntax error at or near "CREATTE"'), { code: '42601' });
        const querySpy = vi.spyOn(Pool.prototype, 'query').mockRejectedValue(sqlErr);

        const res = await handler();
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error).toBe(sqlErr.message);
        expect(querySpy).toHaveBeenCalledTimes(1);
        expect(Pool.prototype.end).toHaveBeenCalledTimes(1);   // finally still runs
    });

    it('recovers from one Aurora cold-start timeout and succeeds on retry', async () => {
        vi.useFakeTimers();
        const querySpy = vi.spyOn(Pool.prototype, 'query')
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce({});

        const pending = handler();
        await vi.advanceTimersByTimeAsync(5000);   // first backoff (delayMs * attempt 1)
        const res = await pending;

        expect(res.statusCode).toBe(200);
        expect(querySpy).toHaveBeenCalledTimes(2);
    });

    it('gives up and returns 500 after exhausting all connectivity retries', async () => {
        vi.useFakeTimers();
        const querySpy = vi.spyOn(Pool.prototype, 'query').mockRejectedValue(netError('ETIMEDOUT'));

        const pending = handler();
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(10000);
        const res = await pending;

        expect(res.statusCode).toBe(500);
        expect(querySpy).toHaveBeenCalledTimes(3);   // default retries: 3 total attempts
        expect(Pool.prototype.end).toHaveBeenCalledTimes(1);
    });
});
