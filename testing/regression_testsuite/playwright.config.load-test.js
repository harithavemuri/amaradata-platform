// @ts-check
/**
 * Playwright config used ONLY by scripts/run-load-test.js's 5 concurrent
 * worker processes — not run directly, and never via `npm run test:regression*`.
 *
 * Differs from the main playwright.config.js in two ways:
 *   1. reuseExistingServer: true — run-load-test.js starts one shared DB-mode
 *      server up front and health-checks it; every worker process must attach
 *      to that same server rather than each trying to start its own on the
 *      same port. (The main config keeps this false deliberately — see
 *      feedback_stale_server_port_8002-equivalent risk in rohas-group's
 *      memory: reusing a server silently reuses a wrong-mode one. Safe here
 *      only because the orchestrator itself just started and verified it.)
 *   2. No globalSetup/globalTeardown — seeding (via global-setup.js) happens
 *      exactly ONCE, run directly by run-load-test.js before any worker
 *      spawns, not 5 times concurrently (which would race truncate/reseed
 *      against itself).
 *
 * Still wires the performance reporter — 5 processes writing to the same
 * day-file concurrently is a real exercise of perf-aggregate.js's
 * cross-process file lock, not just a DB-mode correctness check.
 */
const { defineConfig, devices } = require('@playwright/test');
const { resolveReporterMode } = require('./helpers/perf-aggregate.js');

const TEST_DB_NAME = process.env.TEST_DB_NAME || 'amaradata-platform_test';

module.exports = defineConfig({
    testDir:  '.',
    timeout:  30_000,
    retries:  0,
    workers:  1, // each OS process itself stays workers:1 — concurrency comes from running 5 processes, not 5 in-process workers

    reporter: [
        ['list'],
        // Always DB mode here, but resolve via the same shared logic as the main
        // config rather than hardcoding 'db' — reports 'regressiondb' as long as
        // the safety-guarded _test database is what's actually being hit (see
        // resolveReporterMode's doc comment for why a bare 'db' tag is misleading).
        ['./helpers/performance-reporter.cjs', { mode: resolveReporterMode(true, TEST_DB_NAME) }],
    ],

    use: {
        baseURL:    'http://localhost:9001',
        headless:   true,
        screenshot: 'only-on-failure',
        video:      'retain-on-failure',
        trace:      'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use:  { ...devices['Desktop Chrome'] },
        },
    ],

    webServer: {
        command:             'node start-server-db.js',
        url:                 'http://localhost:9001/api/site-config',
        reuseExistingServer: true,
        timeout:             15_000,
        stdout:              'pipe',
        stderr:              'pipe',
    },
});
