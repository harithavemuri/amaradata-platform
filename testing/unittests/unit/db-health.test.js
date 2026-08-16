// @vitest-environment node
/**
 * backend/services/db-health.js — a small circuit breaker that drives
 * automatic NonDB-mode fallback purely from real DB connectivity failures.
 * markDown() must only ever be called by db.js when isConnectivityError(err)
 * is true (a query error like a unique-constraint violation must never touch
 * this module) — this file tests the breaker's own state machine in
 * isolation; db-query-resilience.test.js proves db.js only calls it on
 * genuine connectivity failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('db-health', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('starts healthy — shouldTryDb() is true before any failure', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        expect(dbHealth.shouldTryDb()).toBe(true);
        expect(dbHealth.getStatus().healthy).toBe(true);
    });

    it('markDown() flips shouldTryDb() to false and logs the error', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        dbHealth.markDown(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));

        expect(dbHealth.shouldTryDb()).toBe(false);
        expect(dbHealth.getStatus().healthy).toBe(false);
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(errSpy.mock.calls[0][0]).toContain('db_connectivity_error');
        errSpy.mockRestore();
    });

    it('logs every single markDown() call, not just the first', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        dbHealth.markDown(new Error('one'));
        dbHealth.markDown(new Error('two'));
        dbHealth.markDown(new Error('three'));
        expect(errSpy).toHaveBeenCalledTimes(3);
        errSpy.mockRestore();
    });

    it('shouldTryDb() stays false until the cooldown window elapses', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        dbHealth.markDown(new Error('down'));

        expect(dbHealth.shouldTryDb()).toBe(false);
        vi.advanceTimersByTime(14_999);
        expect(dbHealth.shouldTryDb()).toBe(false);
        vi.advanceTimersByTime(2);
        expect(dbHealth.shouldTryDb()).toBe(true);
    });

    it('a repeated markDown() while already down restarts the cooldown window', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        dbHealth.markDown(new Error('down'));
        vi.advanceTimersByTime(15_000);
        expect(dbHealth.shouldTryDb()).toBe(true); // cooldown elapsed, a trial is due

        // The trial itself failed — this must push the window back out, not
        // leave shouldTryDb() permanently true from here on.
        dbHealth.markDown(new Error('still down'));
        expect(dbHealth.shouldTryDb()).toBe(false);
        vi.advanceTimersByTime(14_999);
        expect(dbHealth.shouldTryDb()).toBe(false);
        vi.advanceTimersByTime(2);
        expect(dbHealth.shouldTryDb()).toBe(true);
    });

    it('markUp() clears the down state and logs a recovery message', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        vi.spyOn(console, 'error').mockImplementation(() => {});
        dbHealth.markDown(new Error('down'));
        expect(dbHealth.shouldTryDb()).toBe(false);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dbHealth.markUp();
        expect(dbHealth.shouldTryDb()).toBe(true);
        expect(dbHealth.getStatus().healthy).toBe(true);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('db_recovered');
        warnSpy.mockRestore();
    });

    it('markUp() while already healthy is a silent no-op (no recovery log)', async () => {
        const dbHealth = await import('../../../backend/services/db-health.js');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dbHealth.markUp();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('DB_HEALTH_RECHECK_MS overrides the default cooldown', async () => {
        process.env.DB_HEALTH_RECHECK_MS = '5000';
        try {
            const dbHealth = await import('../../../backend/services/db-health.js');
            vi.spyOn(console, 'error').mockImplementation(() => {});
            dbHealth.markDown(new Error('down'));
            vi.advanceTimersByTime(4999);
            expect(dbHealth.shouldTryDb()).toBe(false);
            vi.advanceTimersByTime(2);
            expect(dbHealth.shouldTryDb()).toBe(true);
        } finally {
            delete process.env.DB_HEALTH_RECHECK_MS;
        }
    });
});
