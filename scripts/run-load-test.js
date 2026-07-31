#!/usr/bin/env node
/**
 * Pre-deploy concurrent load test: N concurrent simulated users (default 5),
 * for a bounded duration, using the real testing/regression_testsuite
 * Playwright suite in DB mode against the local `_test` database — proves
 * concurrent full user journeys don't corrupt shared data.
 *
 * "N concurrent users" = N separate `npx playwright test` OS processes
 * running at once (not one Playwright invocation with workers:N) — each
 * process itself stays workers:1. Data-collision avoidance comes from
 * helpers/edit-save.js's uniqueSuffix() (timestamp + random per call), not
 * from routing each process to a distinct pre-seeded row.
 *
 * The DB-mode server is started once, up front, and shared by all N
 * processes — playwright.config.load-test.js's reuseExistingServer: true
 * means each process's own webServer detects it and doesn't try to start a
 * second one on the same port. Seeding (truncate + create seed users) also
 * happens exactly once, before any worker spawns — see that config's header
 * comment for why running global-setup.js N times concurrently would race.
 *
 * Requires the `amaradata-platform_test` database to already exist with the
 * schema applied (see CLAUDE.md's Testing section).
 *
 * Usage:
 *   node scripts/run-load-test.js [--users 5] [--duration-ms 60000]
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { buildWorkerEnv, summarizeLoadTestResults } = require(
    '../testing/regression_testsuite/helpers/load-test-runner.js'
);
const { startServer, waitForServerReady, ROOT } = require('./test-server-lifecycle');

function extractArg(flag, fallback) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return fallback;
}

const NUM_USERS = Number(extractArg('--users', '5'));
// Must comfortably exceed the full suite's normal single-process runtime
// (~6 minutes as of this writing — see `npm run test:regression:db`'s own
// timing) since --global-timeout is a hard cutoff: Playwright marks the
// whole run as failed/timed-out if it doesn't finish within the bound,
// it does not just stop gracefully and report partial results as a pass.
const DURATION_MS = Number(extractArg('--duration-ms', '900000')); // 15 min
const SERVER_START_TIMEOUT_MS = 20_000;

function runOneUser(userIndex) {
    return new Promise((resolve) => {
        const configPath = path.join(ROOT, 'testing/regression_testsuite/playwright.config.load-test.js');
        const args = ['playwright', 'test', `--config=${configPath}`, `--global-timeout=${DURATION_MS}`];
        const env = buildWorkerEnv(userIndex, process.env);
        const child = spawn('npx', args, {
            cwd: ROOT,
            env,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const prefix = `[user${userIndex}]`;
        child.stdout.on('data', (d) => process.stdout.write(`${prefix} ${d}`));
        child.stderr.on('data', (d) => process.stderr.write(`${prefix} ${d}`));
        child.on('exit', (exitCode) => resolve({ userIndex, exitCode }));
    });
}

async function seedOnce() {
    process.env.REGRESSION_DB = '1';
    const globalSetup = require('../testing/regression_testsuite/global-setup.js');
    await globalSetup();
}

async function main() {
    console.log(`Pre-deploy load test: ${NUM_USERS} concurrent users, ${DURATION_MS}ms bound, DB mode (_test database).`);
    console.log('Starting shared test server...');

    const server = startServer('db');
    const ready = await waitForServerReady(SERVER_START_TIMEOUT_MS);
    if (!ready) {
        console.error(
            `Server did not become healthy within ${SERVER_START_TIMEOUT_MS}ms. `
            + 'Make sure amaradata-platform_test exists with the schema applied (database/schema.sql).'
        );
        server.kill();
        process.exitCode = 1;
        return;
    }

    console.log('Server ready. Seeding once before launching concurrent workers...');
    try {
        await seedOnce();
    } catch (err) {
        console.error('Seeding failed:', err.message);
        server.kill();
        process.exitCode = 1;
        return;
    }

    console.log('Launching concurrent user processes...');
    const results = await Promise.all(
        Array.from({ length: NUM_USERS }, (_, i) => runOneUser(i))
    );

    server.kill();

    const summary = summarizeLoadTestResults(results);
    console.log('\n--- Load test summary ---');
    console.log(`Processes: ${summary.totalProcesses}  Passed: ${summary.passedCount}  Failed: ${summary.failedCount}`);
    if (!summary.allPassed) {
        console.log(`Failed user indices: ${summary.failedUserIndices.join(', ')}`);
    }

    process.exitCode = summary.allPassed ? 0 : 1;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
