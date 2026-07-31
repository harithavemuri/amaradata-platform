// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    aggregateTestCalls,
    buildRunAggregate,
    dayFilePath,
    appendRunToDayFile,
    resolveReporterMode,
} from '../../../testing/regression_testsuite/helpers/perf-aggregate.js';

describe('aggregateTestCalls', () => {
    it('sums API call durations and counts calls', () => {
        const calls = [{ durationMs: 100 }, { durationMs: 250 }, { durationMs: 50 }];
        expect(aggregateTestCalls(calls)).toEqual({ apiCallCount: 3, apiTotalMs: 400 });
    });

    it('treats a missing durationMs as 0', () => {
        const calls = [{ durationMs: 100 }, { durationMs: null }, {}];
        expect(aggregateTestCalls(calls)).toEqual({ apiCallCount: 3, apiTotalMs: 100 });
    });

    it('returns all-zero for an empty call list', () => {
        expect(aggregateTestCalls([])).toEqual({ apiCallCount: 0, apiTotalMs: 0 });
    });
});

describe('buildRunAggregate', () => {
    it('averages UI/API durations across tests and totals API calls', () => {
        const tests = [
            { uiDurationMs: 100, apiTotalMs: 40, apiCallCount: 2 },
            { uiDurationMs: 200, apiTotalMs: 60, apiCallCount: 3 },
        ];
        expect(buildRunAggregate(tests)).toEqual({
            avgUiDurationMs: 150,
            avgApiTotalMs: 50,
            totalApiCalls: 5,
        });
    });

    it('returns all-zero (not NaN/Infinity) for an empty test list', () => {
        expect(buildRunAggregate([])).toEqual({ avgUiDurationMs: 0, avgApiTotalMs: 0, totalApiCalls: 0 });
    });
});

describe('dayFilePath', () => {
    it('names the file perf-YYYY-MM-DD.json using the UTC calendar day', () => {
        const date = new Date('2026-07-26T23:59:00Z');
        expect(dayFilePath('/base', date)).toBe(path.join('/base', 'perf-2026-07-26.json'));
    });
});

describe('resolveReporterMode', () => {
    it('returns nondb when DB mode is disabled, regardless of DB name', () => {
        expect(resolveReporterMode(false, 'amaradata-platform_test')).toBe('nondb');
        expect(resolveReporterMode(false, 'amaradata-platform')).toBe('nondb');
    });

    it('returns regressiondb when DB mode is enabled and the DB name ends in _test', () => {
        expect(resolveReporterMode(true, 'amaradata-platform_test')).toBe('regressiondb');
    });

    it('returns db when DB mode is enabled but the DB name does NOT end in _test (a real/live database)', () => {
        expect(resolveReporterMode(true, 'amaradata-platform')).toBe('db');
        expect(resolveReporterMode(true, 'amaradata-platform-prod')).toBe('db');
    });

    it('returns db for a missing/empty DB name under DB mode (fails safe toward the more alarming label)', () => {
        expect(resolveReporterMode(true, '')).toBe('db');
        expect(resolveReporterMode(true, undefined)).toBe('db');
    });
});

describe('appendRunToDayFile', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amrd-perf-agg-unit-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates the base directory and day file fresh on first write', () => {
        const date = new Date('2026-07-26T12:00:00Z');
        appendRunToDayFile(tmpDir, { runId: 'run-1' }, date);

        const filePath = dayFilePath(tmpDir, date);
        expect(fs.existsSync(filePath)).toBe(true);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(data.date).toBe('2026-07-26');
        expect(data.runs).toEqual([{ runId: 'run-1' }]);
    });

    it('appends to existing runs without overwriting them', () => {
        const date = new Date('2026-07-26T12:00:00Z');
        appendRunToDayFile(tmpDir, { runId: 'run-1' }, date);
        appendRunToDayFile(tmpDir, { runId: 'run-2' }, date);

        const data = JSON.parse(fs.readFileSync(dayFilePath(tmpDir, date), 'utf8'));
        expect(data.runs.map((r) => r.runId)).toEqual(['run-1', 'run-2']);
    });

    it('starts fresh (does not throw) if the existing day file is corrupt', () => {
        const date = new Date('2026-07-26T12:00:00Z');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(dayFilePath(tmpDir, date), 'not valid json{{{');

        expect(() => appendRunToDayFile(tmpDir, { runId: 'run-1' }, date)).not.toThrow();
        const data = JSON.parse(fs.readFileSync(dayFilePath(tmpDir, date), 'utf8'));
        expect(data.runs).toEqual([{ runId: 'run-1' }]);
    });

    it('releases the lock directory after a successful write', () => {
        const date = new Date('2026-07-26T12:00:00Z');
        appendRunToDayFile(tmpDir, { runId: 'run-1' }, date);
        const lockPath = `${dayFilePath(tmpDir, date)}.lock`;
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('throws a clear error if the lock is already held past the deadline', () => {
        const date = new Date('2026-07-26T12:00:00Z');
        fs.mkdirSync(tmpDir, { recursive: true });
        const lockPath = `${dayFilePath(tmpDir, date)}.lock`;
        fs.mkdirSync(lockPath); // simulate another process already holding the lock

        expect(() => appendRunToDayFile(tmpDir, { runId: 'run-1' }, date, 200))
            .toThrow(/Timed out waiting for perf day-file lock/);
    });
});
