// @vitest-environment node
/**
 * backend/db.js's query() — read/write split on a DB connectivity failure.
 *
 * Reads retry transparently through a connectivity error (withConnectRetry,
 * already proven in db-connect-retry.test.js). Writes never auto-retry — a
 * write's outcome is unknown after a connectivity failure, so retrying it
 * blindly risks double-applying it — instead the error is re-thrown flagged
 * `dbUnavailable: true` so route catch blocks (via services/http-errors.js)
 * can return a clean 503 instead of the raw pg error.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

const netError = (code) => Object.assign(new Error(`connect ${code}`), { code });

// db.js reads TRANSACTIONDATA_DIR once at module load time (same convention
// as file-db-service.test.js) — point it at an isolated scratch dir *before*
// requiring db.js, so the write-mirror feature never touches testing/testdata
// or the real transactiondata/ directory.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrd-db-mirror-'));
process.env.TRANSACTIONDATA_DIR = tmpDir;

// testing/unittests/setup.js sets NONDB_MODE=true for the whole run (this
// repo's shared file-based-mode default) — db.js short-circuits to a
// throwing stub under that flag, so it must be unset before requiring db.js
// here, where we're deliberately exercising the real Postgres-pool path.
const wasNonDb = process.env.NONDB_MODE;
delete process.env.NONDB_MODE;
const dbModule = require_('../../../backend/db.js');
if (wasNonDb !== undefined) process.env.NONDB_MODE = wasNonDb;

// vi.mock() does not reliably intercept require() calls nested inside another
// CJS module's own require graph (same gotcha documented in
// auth-secret-retry.test.js against services/secrets.js) — db.js's internal
// require('pg') is exactly that case, so mocking 'pg' itself doesn't take
// effect. Instead, overwrite .query directly on the real (but never actually
// connected-to) Pool instances db.js exports — db.js looks up pool.query at
// call time, not a captured reference, so this substitution is seen.
const queryMock = vi.fn();
dbModule.writePool.query = queryMock;
dbModule.readPool.query  = queryMock;
const { query } = dbModule;

// Same not-destructured-in-db.js reasoning as writePool/readPool above —
// db.js does `const dbHealth = require('./services/db-health')` and calls
// dbHealth.markDown/markUp as live property reads, so overwriting them here
// on the same require-cache instance is actually observed.
const dbHealthModule = require_('../../../backend/services/db-health.js');
const markDownMock = vi.fn();
const markUpMock   = vi.fn();
dbHealthModule.markDown = markDownMock;
dbHealthModule.markUp   = markUpMock;

beforeEach(() => { queryMock.mockReset(); markDownMock.mockReset(); markUpMock.mockReset(); });
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('db.query — reads', () => {
    // withConnectRetry backs off 5s/10s for real between attempts; fake timers
    // avoid actually waiting (and avoid leaving an orphaned real setTimeout
    // running past a would-be test timeout, which previously corrupted the
    // shared queryMock's call count in later tests).
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('retries through a connectivity error and returns the eventual result', async () => {
        queryMock
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce({ rows: [{ id: 1 }] });

        const promise = query('SELECT * FROM tenants');
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result.rows).toEqual([{ id: 1 }]);
        expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it('marks db-health down on the failed attempt and back up once it recovers', async () => {
        queryMock
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce({ rows: [{ id: 1 }] });

        const promise = query('SELECT * FROM tenants');
        await vi.runAllTimersAsync();
        await promise;

        expect(markDownMock).toHaveBeenCalledTimes(1);
        expect(markUpMock).toHaveBeenCalledTimes(1);
    });

    it('marks db-health down once per exhausted-retries failure, never marks up', async () => {
        // Rejection created fresh inside the implementation callback, at the
        // moment the mock is actually invoked — chaining multiple
        // mockRejectedValueOnce() calls up front instead constructs all
        // three Promise.reject() instances immediately, before
        // withConnectRetry's backoff has even started, which left later ones
        // sitting unobserved long enough to trip Node's unhandled-rejection
        // detector under fake timers (a benign PromiseRejectionHandledWarning
        // that nonetheless fails the suite).
        queryMock.mockImplementation(() => Promise.reject(netError('ECONNREFUSED')));

        const promise = query('SELECT * FROM tenants');
        promise.catch(() => {}); // observed immediately, before any timer advances
        await vi.runAllTimersAsync();
        await expect(promise).rejects.toMatchObject({ code: 'ECONNREFUSED' });

        // 3 retry attempts: onRetry fires after attempts 1 and 2 (before each
        // sleep), and the final exhausted-retries throw is caught once more —
        // every one of the 3 failures gets logged, none silently dropped.
        expect(markDownMock).toHaveBeenCalledTimes(3);
        expect(markUpMock).not.toHaveBeenCalled();
    });

    it('a query that succeeds on the first try still marks db-health up', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await query('SELECT * FROM tenants');
        expect(markUpMock).toHaveBeenCalledTimes(1);
        expect(markDownMock).not.toHaveBeenCalled();
    });
});

describe('db.query — writes', () => {
    it('does not retry on a connectivity error and flags it dbUnavailable', async () => {
        queryMock.mockRejectedValue(netError('ECONNREFUSED'));

        await expect(query('INSERT INTO tenants (name) VALUES ($1)', ['x']))
            .rejects.toMatchObject({ dbUnavailable: true });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('marks db-health down on a connectivity failure', async () => {
        queryMock.mockRejectedValue(netError('ECONNREFUSED'));
        await expect(query('INSERT INTO tenants (name) VALUES ($1)', ['x'])).rejects.toBeTruthy();
        expect(markDownMock).toHaveBeenCalledTimes(1);
    });

    it('passes through a non-connectivity error unchanged and never touches db-health', async () => {
        const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
        queryMock.mockRejectedValue(uniqueViolation);

        await expect(query('INSERT INTO tenants (name) VALUES ($1)', ['x']))
            .rejects.toBe(uniqueViolation);
        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(markDownMock).not.toHaveBeenCalled();
        expect(markUpMock).not.toHaveBeenCalled();
    });
});

describe('db.query — write-to-file mirror', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('mirrors a successful write on a manifest table to transactiondata/<table>.json', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme' }] })      // the INSERT itself
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme' }] });     // the mirror's SELECT *

        await query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', ['Acme']);

        expect(queryMock).toHaveBeenCalledTimes(2);
        const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tenants.json'), 'utf8'));
        expect(written).toEqual([{ id: 1, name: 'Acme' }]);
    });

    it('does not fail the write if the file mirror itself errors', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Beta' }] })
            .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Beta' }] });
        vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full'); });

        const result = await query('INSERT INTO tenants (name) VALUES ($1) RETURNING *', ['Beta']);
        expect(result.rows).toEqual([{ id: 2, name: 'Beta' }]);
    });

    // backend/routes/admin.js's POST /sync-from-db loops every manifest table
    // and reports a row count per table straight from this return value.
    it('mirrorTableToFile() resolves with the row count written', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        await expect(dbModule.mirrorTableToFile('tenants')).resolves.toBe(3);
    });
});

describe('db.js — sync progress tracking (.progress.json)', () => {
    it('readSyncProgress() returns an empty tables map before anything has synced', async () => {
        // No .progress.json has been written into tmpDir by any earlier test
        // in this file (they all write <table>.json, not the dotfile).
        await expect(dbModule.readSyncProgress()).resolves.toEqual({ tables: {} });
    });

    it('updateSyncProgress() creates the file on first call and merges on subsequent ones', async () => {
        await dbModule.updateSyncProgress('tenants', { success: true, rows: 5, synced_at: '2026-01-01T00:00:00.000Z' });
        let progress = await dbModule.readSyncProgress();
        expect(progress.tables.tenants).toEqual({ success: true, rows: 5, synced_at: '2026-01-01T00:00:00.000Z' });

        await dbModule.updateSyncProgress('invoices', { success: false, error: 'boom', synced_at: '2026-01-01T00:01:00.000Z' });
        progress = await dbModule.readSyncProgress();
        // Both entries survive — a later table's update must not clobber an earlier one.
        expect(progress.tables.tenants.rows).toBe(5);
        expect(progress.tables.invoices).toEqual({ success: false, error: 'boom', synced_at: '2026-01-01T00:01:00.000Z' });

        const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.progress.json'), 'utf8'));
        expect(written.tables.tenants.rows).toBe(5);
    });
});

describe('services/http-errors — sendError', () => {
    it('responds 503 with a retry message for a dbUnavailable error', async () => {
        const { sendError } = require_('../../../backend/services/http-errors.js');
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        const err = Object.assign(new Error('nope'), { dbUnavailable: true });

        sendError(res, err, '[test]');
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('retry') });
    });

    it('falls back to the existing generic 500 for any other error', async () => {
        const { sendError } = require_('../../../backend/services/http-errors.js');
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

        sendError(res, new Error('boom'), '[test]');
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
});
