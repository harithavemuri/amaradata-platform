// @vitest-environment node
/**
 * backend/lambda/db-migrate.js — splitSql() (pure) and the DBMigrateFn handler's
 * own wiring (pool config, connect-retry integration, critical vs non-critical
 * error classification), not just the extracted retry helper (already covered
 * by db-connect-retry.test.js).
 *
 * pg's Pool.prototype.connect/end are spied on directly (not the module's
 * destructured `Pool` binding) — see db-init-handler.test.js's header comment
 * for why that's the reliable mocking point here. connect() resolves a fake
 * client object so no real Postgres connection is ever attempted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_    = createRequire(import.meta.url);
const { Pool }     = require_('pg');
const { handler, splitSql } = require_('../../../backend/lambda/db-migrate.js');

const netError = (code) => Object.assign(new Error(`connect ${code}`), { code });

function fakeClient(queryImpl) {
    return { query: vi.fn(queryImpl), release: vi.fn() };
}

describe('splitSql', () => {
    it('splits plain statements on semicolons', () => {
        expect(splitSql('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('ignores a trailing statement with no closing semicolon', () => {
        expect(splitSql('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('does not split on a semicolon inside a single-quoted string', () => {
        expect(splitSql("INSERT INTO t VALUES ('a;b'); SELECT 1;"))
            .toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT 1']);
    });

    it("handles an escaped single quote inside a string (two single quotes in a row)", () => {
        expect(splitSql("INSERT INTO t VALUES ('it''s here'); SELECT 1;"))
            .toEqual(["INSERT INTO t VALUES ('it''s here')", 'SELECT 1']);
    });

    it('ignores a semicolon inside a single-line comment', () => {
        expect(splitSql('SELECT 1; -- comment; with a semicolon\nSELECT 2;'))
            .toEqual(['SELECT 1', '-- comment; with a semicolon\nSELECT 2']);
    });

    it('does not split on semicolons inside a dollar-quoted DO block', () => {
        const sql = "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$; SELECT 1;";
        expect(splitSql(sql)).toEqual(["DO $$ BEGIN RAISE NOTICE 'a;b'; END $$", 'SELECT 1']);
    });

    it('does not split on semicolons inside a tagged dollar-quoted block ($body$)', () => {
        const sql = 'DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2;';
        expect(splitSql(sql)).toEqual(['DO $body$ BEGIN PERFORM 1; END $body$', 'SELECT 2']);
    });

    it('returns an empty array for blank input', () => {
        expect(splitSql('')).toEqual([]);
        expect(splitSql('   \n  ')).toEqual([]);
    });
});

describe('db-migrate handler', () => {
    beforeEach(() => {
        process.env.AMRD_DB_HOST      = 'test-host';
        process.env.AMRD_DB_NAME      = 'test-db';
        process.env.DB_MASTER_USER    = 'test-master';
        process.env.DB_MASTER_PASSWORD = 'test-master-password';
        vi.spyOn(Pool.prototype, 'end').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('applies the real schema.sql cleanly and reports the run/skip counts', async () => {
        const client = fakeClient(async () => ({}));
        vi.spyOn(Pool.prototype, 'connect').mockResolvedValue(client);

        const res = await handler();
        expect(res.success).toBe(true);
        expect(res.message).toMatch(/^\d+ statements applied, \d+ skipped \(already exist\)$/);
        expect(client.query.mock.calls.length).toBeGreaterThan(0);
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(Pool.prototype.end).toHaveBeenCalledTimes(1);
    });

    it('treats "already exists" statement errors as non-critical and still succeeds', async () => {
        let call = 0;
        const client = fakeClient(async () => {
            call++;
            if (call === 1) throw Object.assign(new Error('relation "amr_users" already exists'), { code: '42P07' });
            return {};
        });
        vi.spyOn(Pool.prototype, 'connect').mockResolvedValue(client);

        const res = await handler();
        expect(res.success).toBe(true);
        expect(res.message).toMatch(/^\d+ statements applied, [1-9]\d* skipped \(already exist\)$/);
    });

    it('treats a genuine SQL error as critical and reports failure', async () => {
        const client = fakeClient(async () => {
            throw Object.assign(new Error('syntax error at or near "CREATTE"'), { code: '42601' });
        });
        vi.spyOn(Pool.prototype, 'connect').mockResolvedValue(client);

        const res = await handler();
        expect(res.success).toBe(false);
        expect(res.error).toBe('syntax error at or near "CREATTE"');
        expect(res.details.length).toBeGreaterThan(0);
        expect(client.release).toHaveBeenCalledTimes(1);   // still cleaned up
    });

    it('recovers from one Aurora cold-start timeout on connect and completes the migration', async () => {
        vi.useFakeTimers();
        const client = fakeClient(async () => ({}));
        const connectSpy = vi.spyOn(Pool.prototype, 'connect')
            .mockRejectedValueOnce(netError('ETIMEDOUT'))
            .mockResolvedValueOnce(client);

        const pending = handler();
        await vi.advanceTimersByTimeAsync(5000);   // first backoff
        const res = await pending;

        expect(res.success).toBe(true);
        expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects when connect never recovers after exhausting retries (matches current behavior — not caught internally)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Pool.prototype, 'connect').mockRejectedValue(netError('ETIMEDOUT'));

        const pending = handler();
        // Attach the rejection handler before advancing timers so the rejection
        // that lands mid-advance is never briefly unhandled.
        const assertion = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(10000);
        await assertion;
    });
});
