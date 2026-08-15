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

beforeEach(() => { queryMock.mockReset(); });
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
});

describe('db.query — writes', () => {
    it('does not retry on a connectivity error and flags it dbUnavailable', async () => {
        queryMock.mockRejectedValue(netError('ECONNREFUSED'));

        await expect(query('INSERT INTO tenants (name) VALUES ($1)', ['x']))
            .rejects.toMatchObject({ dbUnavailable: true });
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('passes through a non-connectivity error unchanged', async () => {
        const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
        queryMock.mockRejectedValue(uniqueViolation);

        await expect(query('INSERT INTO tenants (name) VALUES ($1)', ['x']))
            .rejects.toBe(uniqueViolation);
        expect(queryMock).toHaveBeenCalledTimes(1);
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
