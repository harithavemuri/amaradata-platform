// @ts-check
/**
 * backend/services/db-retry.js — recovery from a cold/unreachable DB at connect time.
 *
 * DBInitFn and DBMigrateFn (backend/lambda/db-init.js, db-migrate.js) run against
 * the shared Aurora Serverless v2 cluster, which can take up to ~30s to resume from
 * a scale-to-zero pause. A connection attempt that lands during that window fails
 * with a connectivity error (ETIMEDOUT / "Connection terminated" / "timeout expired"),
 * not a real, permanent problem — retrying with backoff is what recovers it.
 *
 * This is a distinct concern from withAuthRetry in this same file (a rotated
 * password mid-flight): that retries exactly once on an auth SQLSTATE, this retries
 * a bounded number of times on a connectivity failure, and the two must never
 * conflate each other's error classes — a bad password must not be retried as if
 * Aurora were merely asleep, and a cold-start timeout must not be treated as a
 * credential problem.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { isConnectivityError, withConnectRetry } = require_('../../../backend/services/db-retry.js');

const netError = (code) => Object.assign(new Error(`connect ${code}`), { code });
const msgError = (message) => new Error(message);

describe('isConnectivityError', () => {
    it.each([
        ['ETIMEDOUT', 'ETIMEDOUT'],
        ['ECONNREFUSED', 'ECONNREFUSED'],
        ['ECONNRESET', 'ECONNRESET'],
        ['EHOSTUNREACH', 'EHOSTUNREACH'],
        ['ENETUNREACH', 'ENETUNREACH'],
        ['ENOTFOUND', 'ENOTFOUND'],
    ])('recognises the %s network error code', (_label, code) => {
        expect(isConnectivityError(netError(code))).toBe(true);
    });

    it.each([
        ["pg's own connectionTimeoutMillis message", 'timeout expired'],
        ['a mid-query dropped connection', 'Connection terminated unexpectedly'],
    ])('recognises %s by message', (_label, message) => {
        expect(isConnectivityError(msgError(message))).toBe(true);
    });

    it.each([
        ['an auth failure (wrong password, not a connectivity problem)', Object.assign(new Error('bad password'), { code: '28P01' })],
        ['a SQL syntax error in the schema file', Object.assign(new Error('syntax error at or near "CREATTE"'), { code: '42601' })],
        ['a unique violation', Object.assign(new Error('duplicate key'), { code: '23505' })],
    ])('does not treat %s as a connectivity error', (_label, err) => {
        expect(isConnectivityError(err)).toBe(false);
    });

    it('tolerates a null/undefined error without throwing', () => {
        expect(isConnectivityError(null)).toBe(false);
        expect(isConnectivityError(undefined)).toBe(false);
    });
});

describe('withConnectRetry', () => {
    it('returns the result on the first successful attempt with no sleeping', async () => {
        const run   = vi.fn().mockResolvedValue('ok');
        const sleep = vi.fn().mockResolvedValue(undefined);

        expect(await withConnectRetry(run, { sleep })).toBe('ok');
        expect(run).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries on a connectivity error and succeeds once Aurora wakes up', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce('ok-third-try');
        const sleep = vi.fn().mockResolvedValue(undefined);

        expect(await withConnectRetry(run, { retries: 3, sleep })).toBe('ok-third-try');
        expect(run).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('backs off with an increasing delay between attempts', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce('ok');
        const sleep = vi.fn().mockResolvedValue(undefined);

        await withConnectRetry(run, { retries: 3, delayMs: 5000, sleep });
        expect(sleep.mock.calls[0][0]).toBe(5000);
        expect(sleep.mock.calls[1][0]).toBe(10000);
    });

    it('gives up after exhausting retries and throws the last connectivity error', async () => {
        const run   = vi.fn().mockRejectedValue(netError('ETIMEDOUT'));
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(withConnectRetry(run, { retries: 3, sleep })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        expect(run).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('propagates a non-connectivity error immediately without retrying', async () => {
        const authErr = Object.assign(new Error('bad password'), { code: '28P01' });
        const run     = vi.fn().mockRejectedValue(authErr);
        const sleep   = vi.fn().mockResolvedValue(undefined);

        await expect(withConnectRetry(run, { retries: 3, sleep })).rejects.toBe(authErr);
        expect(run).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('calls onRetry with the error and attempt number for observability', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce('ok');
        const sleep   = vi.fn().mockResolvedValue(undefined);
        const onRetry = vi.fn();

        await withConnectRetry(run, { retries: 3, sleep, onRetry });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ code: 'ETIMEDOUT' }), 1);
    });

    it('defaults to 3 total attempts when retries is not specified', async () => {
        const run   = vi.fn().mockRejectedValue(netError('ETIMEDOUT'));
        const sleep = vi.fn().mockResolvedValue(undefined);

        await expect(withConnectRetry(run, { sleep })).rejects.toBeTruthy();
        expect(run).toHaveBeenCalledTimes(3);
    });
});
