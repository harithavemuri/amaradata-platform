// @ts-check
/**
 * Playwright reporter that turns each test's 'perf-calls' attachment (written
 * by perf-tracking.js's page fixture) into one UI->API benchmark entry per
 * run, appended to the day-dated JSON file in testing/performance-testdata
 * (see perf-aggregate.js for the file-naming/append logic, which is unit-
 * tested separately).
 *
 * "UI" time per test = Playwright's own TestResult.duration (the test's
 * whole wall-clock time) — the only time source available here that isn't
 * itself derived from the network calls being measured as "API" time.
 *
 * Wired into testing/regression_testsuite/playwright.config.js's `reporter`
 * array, tagged with mode: 'db'|'nondb' depending on REGRESSION_DB.
 *
 * Usage: ['./helpers/performance-reporter.cjs', { mode: 'nondb' }]
 */
const path = require('path');
const fs = require('fs');
const perfAggregate = require('./perf-aggregate.js');

const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../performance-testdata');

function readAttachment(attachment) {
    if (!attachment) return null;
    if (attachment.body) {
        const buf = Buffer.isBuffer(attachment.body) ? attachment.body : Buffer.from(attachment.body);
        return buf.toString('utf8');
    }
    if (attachment.path && fs.existsSync(attachment.path)) {
        return fs.readFileSync(attachment.path, 'utf8');
    }
    return null;
}

class PerformanceReporter {
    constructor(options = {}) {
        this.mode = options.mode || 'unknown';
        this.outputDir = options.outputDir || process.env.PERF_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
        /** @type {Array<object>} */
        this.tests = [];
        this.startedAt = null;
    }

    onBegin() {
        this.startedAt = new Date();
    }

    onTestEnd(test, result) {
        const { aggregateTestCalls } = perfAggregate;

        const attachment = result.attachments?.find((a) => a.name === 'perf-calls');
        const raw = readAttachment(attachment);
        let calls = [];
        if (raw) {
            try { calls = JSON.parse(raw); } catch { /* malformed attachment — treat as no calls, don't fail the run */ }
        }

        const { apiCallCount, apiTotalMs } = aggregateTestCalls(calls);

        this.tests.push({
            title: test.titlePath().slice(1).join(' > '),
            file: path.relative(process.cwd(), test.location.file),
            status: result.status,
            uiDurationMs: result.duration,
            apiCallCount,
            apiTotalMs,
        });
    }

    onEnd() {
        const { buildRunAggregate, appendRunToDayFile } = perfAggregate;

        const finishedAt = new Date();
        const runEntry = {
            runId: (this.startedAt || finishedAt).toISOString(),
            mode: this.mode,
            startedAt: (this.startedAt || finishedAt).toISOString(),
            finishedAt: finishedAt.toISOString(),
            totalTests: this.tests.length,
            tests: this.tests,
            aggregate: buildRunAggregate(this.tests),
        };

        try {
            appendRunToDayFile(this.outputDir, runEntry, this.startedAt || finishedAt);
        } catch (err) {
            // A benchmark side-channel must never fail the actual test run —
            // report the problem loudly to stdout instead of throwing.
            console.error(`[performance-reporter] Failed to write performance data: ${err.message}`);
        }
    }
}

module.exports = PerformanceReporter;
