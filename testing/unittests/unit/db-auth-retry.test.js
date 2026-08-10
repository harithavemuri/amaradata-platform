// @ts-check
/**
 * backend/services/db-retry.js — recovery from a mid-flight password rotation.
 *
 * When a DB password is rotated, already-open pooled connections keep working
 * (Postgres does not terminate authenticated sessions on ALTER ROLE), but the
 * next *new* connection is opened with the stale cached password and fails
 * authentication. Waiting out the secret cache TTL would mean minutes of errors,
 * so an auth failure is treated as a signal to drop the cached password and
 * retry once with a freshly fetched one.
 *
 * Retrying exactly once is deliberate: a genuinely wrong credential (revoked
 * role, misconfigured secret) must surface as an error rather than spin.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { isAuthError, withAuthRetry } = require_('../../../backend/services/db-retry.js');

/** Shape of a pg auth rejection: the driver sets `code` to the SQLSTATE. */
const pgError = (code) => Object.assign(new Error(`pg error ${code}`), { code });

describe('isAuthError', () => {
    it('recognises invalid_password (28P01) — what a rotated password produces', () => {
        expect(isAuthError(pgError('28P01'))).toBe(true);
    });

    it('recognises invalid_authorization_specification (28000)', () => {
        expect(isAuthError(pgError('28000'))).toBe(true);
    });

    it.each([
        ['a missing relation', '42P01'],
        ['a unique violation', '23505'],
        ['a connection timeout', 'ETIMEDOUT'],
        ['no code at all', undefined],
    ])('does not treat %s as an auth error', (_label, code) => {
        expect(isAuthError(pgError(/** @type {any} */ (code)))).toBe(false);
    });

    it('tolerates a null/undefined error without throwing', () => {
        expect(isAuthError(null)).toBe(false);
        expect(isAuthError(undefined)).toBe(false);
    });
});

describe('withAuthRetry', () => {
    it('returns the result and never invalidates when the call succeeds', async () => {
        const run           = vi.fn().mockResolvedValue('rows');
        const onAuthFailure = vi.fn();

        expect(await withAuthRetry(run, onAuthFailure)).toBe('rows');
        expect(run).toHaveBeenCalledTimes(1);
        expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it('invalidates the cached password and retries once after an auth failure', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(pgError('28P01'))
            .mockResolvedValueOnce('rows-after-refetch');
        const onAuthFailure = vi.fn();

        expect(await withAuthRetry(run, onAuthFailure)).toBe('rows-after-refetch');
        expect(run).toHaveBeenCalledTimes(2);
        expect(onAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('invalidates before retrying, not after — the retry must use a fresh password', async () => {
        const order = [];
        const run = vi.fn()
            .mockImplementationOnce(async () => { order.push('attempt-1'); throw pgError('28P01'); })
            .mockImplementationOnce(async () => { order.push('attempt-2'); return 'ok'; });
        const onAuthFailure = vi.fn(() => { order.push('invalidate'); });

        await withAuthRetry(run, onAuthFailure);
        expect(order).toEqual(['attempt-1', 'invalidate', 'attempt-2']);
    });

    it('gives up after a single retry so a genuinely bad credential surfaces', async () => {
        const run           = vi.fn().mockRejectedValue(pgError('28P01'));
        const onAuthFailure = vi.fn();

        await expect(withAuthRetry(run, onAuthFailure)).rejects.toMatchObject({ code: '28P01' });
        expect(run).toHaveBeenCalledTimes(2);
        expect(onAuthFailure).toHaveBeenCalledTimes(1);
    });

    it('propagates a non-auth error immediately without invalidating or retrying', async () => {
        const run           = vi.fn().mockRejectedValue(pgError('23505'));
        const onAuthFailure = vi.fn();

        await expect(withAuthRetry(run, onAuthFailure)).rejects.toMatchObject({ code: '23505' });
        expect(run).toHaveBeenCalledTimes(1);
        expect(onAuthFailure).not.toHaveBeenCalled();
    });
});
