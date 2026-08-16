// @vitest-environment node
/**
 * backend/middleware/nondb-mode.js — decides req.db.mode per request. Two
 * ways to land in NonDB mode: explicit NONDB_MODE=true (unchanged, existing
 * behavior), or automatically when services/db-health.js's circuit breaker
 * says the DB is down (new). Every NonDB-mode request must be logged (not
 * just the first) — the user wants to alarm on nondb-request volume per hour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const dbHealth  = require_('../../../backend/services/db-health.js');

const wasNonDb = process.env.NONDB_MODE;
delete process.env.NONDB_MODE;
const nondbMode = require_('../../../backend/middleware/nondb-mode.js');
if (wasNonDb !== undefined) process.env.NONDB_MODE = wasNonDb;

function mockReqRes(method = 'GET', path = '/api/tenants') {
    const req = { method, path };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    const next = vi.fn();
    return { req, res, next };
}

describe('nondb-mode middleware', () => {
    let shouldTryDbSpy;
    beforeEach(() => {
        shouldTryDbSpy = vi.spyOn(dbHealth, 'shouldTryDb').mockReturnValue(true);
        delete process.env.NONDB_MODE;
    });
    afterEach(() => { shouldTryDbSpy.mockRestore(); delete process.env.NONDB_MODE; });

    it('routes to DB mode when healthy and NONDB_MODE is unset', () => {
        const { req, res, next } = mockReqRes();
        nondbMode(req, res, next);
        expect(req.db.mode).toBe('db');
        expect(next).toHaveBeenCalledOnce();
    });

    it('NONDB_MODE=true always wins, tagged reason "env"', () => {
        process.env.NONDB_MODE = 'true';
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { req, res, next } = mockReqRes();
        nondbMode(req, res, next);
        expect(req.db.mode).toBe('nondb');
        expect(req.db.reason).toBe('env');
        expect(res.headers['X-DB-Mode']).toBe('nondb');
        expect(res.headers['X-DB-Mode-Reason']).toBe('env');
        expect(next).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it('falls back to NonDB automatically when db-health says not to try the DB, tagged reason "db_unavailable"', () => {
        shouldTryDbSpy.mockReturnValue(false);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { req, res, next } = mockReqRes();
        nondbMode(req, res, next);
        expect(req.db.mode).toBe('nondb');
        expect(req.db.reason).toBe('db_unavailable');
        expect(res.headers['X-DB-Mode-Reason']).toBe('db_unavailable');
        expect(next).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it('logs every single NonDB-mode request, not just the first (alarm-volume requirement)', () => {
        shouldTryDbSpy.mockReturnValue(false);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 5; i++) {
            const { req, res, next } = mockReqRes();
            nondbMode(req, res, next);
        }
        const nondbLogs = warnSpy.mock.calls.filter(([line]) => line.includes('"event":"nondb_request"'));
        expect(nondbLogs).toHaveLength(5);
        warnSpy.mockRestore();
    });

    it('never touches NonDB mode when db-health is healthy, regardless of how many requests come through', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (let i = 0; i < 5; i++) {
            const { req, res, next } = mockReqRes();
            nondbMode(req, res, next);
            expect(req.db.mode).toBe('db');
        }
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
