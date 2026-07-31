// @ts-check
/**
 * Pure UI->API benchmark aggregation and day-file logic for
 * testing/regression_testsuite. Kept dependency-free (no Playwright imports)
 * so it can be unit tested directly — see
 * testing/unittests/unit/perf-aggregate.test.js. The Playwright-specific glue
 * that produces the raw per-call data lives in perf-tracking.js (fixture) and
 * performance-reporter.cjs (reporter); both are thin wrappers around this file.
 *
 * No DB-time breakdown: amaradata's DB-mode routes call a shared, module-level
 * db.query() (backend/db.js) rather than a per-request query interface, so
 * there's no cheap hook to attribute DB time back to a specific request the
 * way rohas-group's per-request req.db object allows. Only API call
 * (round-trip) timing is captured here — see feedback-performance-sla.md.
 *
 * CommonJS deliberately, not ESM: performance-reporter.cjs is loaded by Node's
 * native module loader (not Playwright's own test-file transform, which does
 * support ESM) — this repo's package.json has no "type": "module", so a plain
 * .js file using import/export fails there with "Cannot use import statement
 * outside a module." CommonJS require() works from every caller (this
 * reporter, and Vitest, which interops CJS transparently).
 *
 * Output: one JSON file per calendar day, at
 * <baseDir>/perf-YYYY-MM-DD.json, containing every E2E run started that day
 * (NonDB and DB mode alike) as entries in a `runs` array — never overwritten,
 * always appended to, until the date rolls over to a new file.
 */

const fs = require('fs');
const path = require('path');

/**
 * Sums API call duration across every call recorded for one test.
 * @param {Array<{durationMs?: number}>} calls
 */
function aggregateTestCalls(calls) {
    let apiTotalMs = 0;
    for (const call of calls) {
        apiTotalMs += call.durationMs || 0;
    }
    return { apiCallCount: calls.length, apiTotalMs };
}

/**
 * Averages per-test UI/API durations across a whole run, and totals the API
 * call count. Returns all-zero (not NaN/Infinity) for an empty test list.
 * @param {Array<{uiDurationMs: number, apiTotalMs: number, apiCallCount: number}>} tests
 */
function buildRunAggregate(tests) {
    if (!tests.length) {
        return { avgUiDurationMs: 0, avgApiTotalMs: 0, totalApiCalls: 0 };
    }
    const sum = (fn) => tests.reduce((acc, t) => acc + fn(t), 0);
    return {
        avgUiDurationMs: sum((t) => t.uiDurationMs) / tests.length,
        avgApiTotalMs: sum((t) => t.apiTotalMs) / tests.length,
        totalApiCalls: sum((t) => t.apiCallCount),
    };
}

/** YYYY-MM-DD using the date's UTC calendar day (avoids local-timezone drift near midnight). */
function isoDay(date) {
    return date.toISOString().slice(0, 10);
}

/** @param {string} baseDir @param {Date} date */
function dayFilePath(baseDir, date) {
    return path.join(baseDir, `perf-${isoDay(date)}.json`);
}

// 5 real OS processes (the pre-deploy load test) all finishing and acquiring
// this lock around the same moment, under whatever load the machine happens
// to be under, is real contention — a tight deadline here is a spurious-
// failure risk, not a correctness one. 30s gives headroom for legitimate
// contention while still catching a truly stuck/crashed holder.
const DEFAULT_LOCK_DEADLINE_MS = 30_000;

/**
 * Blocks (this OS process only) until it exclusively holds a lock directory
 * next to the day file, runs fn(), then releases it. Directory creation is
 * atomic at the filesystem level (EEXIST if another process holds it), so
 * this is a real cross-process mutex, not just an in-process one — needed
 * because the pre-deploy load test runs 5 separate `npx playwright test`
 * processes concurrently, each with its own performance-reporter.cjs calling
 * appendRunToDayFile() around the same moment. Without this, concurrent
 * read-modify-write cycles silently drop all but the last writer's run. Uses
 * Atomics.wait for a blocking sleep since this function must stay synchronous
 * — the callers (Playwright reporters' onEnd) don't await it. The retry wait
 * is jittered (15-40ms) rather than a fixed interval so many concurrent
 * waiters don't retry in lockstep and repeatedly collide on the same instant.
 */
function withDayFileLock(lockPath, fn, deadlineMs = DEFAULT_LOCK_DEADLINE_MS) {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        try {
            fs.mkdirSync(lockPath);
            break;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            if (Date.now() > deadline) throw new Error(`Timed out waiting for perf day-file lock: ${lockPath}`);
            const jitterMs = 15 + Math.floor(Math.random() * 25);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, jitterMs);
        }
    }
    try {
        fn();
    } finally {
        fs.rmdirSync(lockPath);
    }
}

/**
 * Appends one run entry into the JSON file for the given date, creating the
 * base directory and/or file fresh if either doesn't exist yet. Never
 * overwrites other runs already recorded for the same day. If the existing
 * file is present but unparseable, starts fresh rather than throwing —
 * losing a corrupt file's history is preferable to crashing an entire E2E
 * run over a benchmark side-channel. Safe against concurrent writers from
 * separate OS processes — see withDayFileLock().
 * @param {string} baseDir
 * @param {object} runEntry
 * @param {Date} [date]
 * @param {number} [lockDeadlineMs] override for how long to wait for the day-file lock (default 30s) — mainly for tests
 */
function appendRunToDayFile(baseDir, runEntry, date = new Date(), lockDeadlineMs = DEFAULT_LOCK_DEADLINE_MS) {
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = dayFilePath(baseDir, date);
    const lockPath = `${filePath}.lock`;

    withDayFileLock(lockPath, () => {
        let data = { date: isoDay(date), runs: [] };
        if (fs.existsSync(filePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (parsed && Array.isArray(parsed.runs)) data = parsed;
            } catch { /* corrupt file — start fresh rather than throw */ }
        }

        data.runs.push(runEntry);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }, lockDeadlineMs);
}

/**
 * Resolves the performance-testdata `mode` tag from what a run actually
 * targeted, not just a static config flag — a bare 'db'/'nondb' split hides
 * the fact that this codebase's DB-mode regression/load runs are *always*
 * against the safety-guarded `_test` database (global-setup.js's
 * `assertTestDb`-equivalent check refuses anything else), never a live one.
 *
 * - NonDB (file-based) -> 'nondb'
 * - DB mode, database name ends in `_test` -> 'regressiondb' (the normal,
 *   only-currently-reachable case for this suite)
 * - DB mode, database name does NOT end in `_test` -> 'db' (a real/live
 *   database — not reachable today given the safety guard, but the label is
 *   correct if that guard is ever bypassed rather than silently mislabeling
 *   it as 'regressiondb')
 *
 * @param {boolean} dbModeEnabled
 * @param {string} testDbName
 */
function resolveReporterMode(dbModeEnabled, testDbName) {
    if (!dbModeEnabled) return 'nondb';
    return testDbName && testDbName.endsWith('_test') ? 'regressiondb' : 'db';
}

module.exports = { aggregateTestCalls, buildRunAggregate, dayFilePath, appendRunToDayFile, resolveReporterMode };
