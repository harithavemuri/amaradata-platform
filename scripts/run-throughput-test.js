#!/usr/bin/env node
/**
 * Throughput/capacity test using autocannon — distinct from
 * scripts/run-load-test.js (which proves N concurrent full-user-journeys
 * don't corrupt shared data, but says nothing about latency/throughput/error
 * rate under load). This one hits a curated set of safe, read-only,
 * auth-agnostic-routing endpoints at high concurrency for a fixed duration
 * each, and fails if p95 latency or error rate breaches the SLA
 * (feedback-performance-sla.md: API <=500ms).
 *
 * autocannon has no exact p95 bucket — p97_5 (its next percentile up) is used
 * as a slightly more conservative stand-in.
 *
 * Usage:
 *   node scripts/run-throughput-test.js [--mode db|nondb] [--connections 10] [--duration 10]
 */

'use strict';

const crypto = require('crypto');
const autocannon = require('autocannon');
const { startServer, waitForServerReady, SERVER_PORT } = require('./test-server-lifecycle');
const { evaluateThroughputResult, summarizeThroughputRun } = require(
    '../testing/regression_testsuite/helpers/throughput-runner.js'
);
const { resolveReporterMode } = require('../testing/regression_testsuite/helpers/perf-aggregate.js');

function extractArg(flag, fallback) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return fallback;
}

// MODE ('db'|'nondb') is only the internal dispatch key for which server
// launcher to start (test-server-lifecycle.js) — --mode db always targets the
// same safety-guarded _test database as the main regression suite, never a
// live one, so the human-facing label uses the same three-way resolution as
// performance-testdata's mode field (see resolveReporterMode's doc comment) —
// a bare "db mode" log line here would be the identical misleading claim.
const MODE = extractArg('--mode', 'nondb');
const CONNECTIONS = Number(extractArg('--connections', '10'));
const DURATION_SEC = Number(extractArg('--duration', '10'));
const SERVER_START_TIMEOUT_MS = 20_000;
const DISPLAY_MODE = resolveReporterMode(MODE === 'db', process.env.TEST_DB_NAME || 'amaradata-platform_test');

// Same fixed test-only secret both testing/regression_testsuite/server-entry.js
// (NonDB) and start-server-db.js (DB) set for AMRD_JWT_SECRET — must match, or
// the minted token below won't verify against whichever server is running.
const TEST_JWT_SECRET = 'playwright-test-secret-32chars!!';

function mintToken(role = 'admin') {
    const payload = { id: 1, email: 'throughput-test@test.local', name: 'Throughput Test', role, type: 'access' };
    return require('jsonwebtoken').sign(payload, TEST_JWT_SECRET, { expiresIn: '15m' });
}

// Endpoints chosen to be safe under high concurrency: /health and
// /api/site-config are explicitly public (no auth, no DB reads beyond a
// version/env lookup); /api/tenants/mine is a read-only GET gated only by
// requireAuth — amaradata has no per-tenant/per-project DB routing
// complexity to worry about here (unlike rohas-group), so this is safe as-is.
function buildEndpoints() {
    const authHeaders = { Accept: 'application/json;v=1', Authorization: `Bearer ${mintToken()}` };
    return [
        { label: 'GET /health', path: '/health', headers: {} },
        { label: 'GET /api/site-config', path: '/api/site-config', headers: {} },
        { label: 'GET /api/tenants/mine', path: '/api/tenants/mine', headers: authHeaders },
    ];
}

function runOne(endpoint) {
    return new Promise((resolve, reject) => {
        autocannon({
            url: `http://localhost:${SERVER_PORT}${endpoint.path}`,
            connections: CONNECTIONS,
            duration: DURATION_SEC,
            headers: endpoint.headers,
        }, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
}

async function main() {
    const ENDPOINTS = buildEndpoints();
    console.log(`Throughput test: ${ENDPOINTS.length} endpoints, ${CONNECTIONS} connections, ${DURATION_SEC}s each, ${DISPLAY_MODE} mode.`);
    console.log('Starting shared test server...');

    const server = startServer(MODE);
    const ready = await waitForServerReady(SERVER_START_TIMEOUT_MS);
    if (!ready) {
        console.error(`Server did not become healthy within ${SERVER_START_TIMEOUT_MS}ms.`);
        server.kill();
        process.exitCode = 1;
        return;
    }
    console.log('Server ready.\n');

    const evaluations = [];
    for (const endpoint of ENDPOINTS) {
        console.log(`Running ${endpoint.label}...`);
        const result = await runOne(endpoint);
        const p95Ms = result.latency.p97_5;
        const evaluation = evaluateThroughputResult(endpoint.label, {
            p95Ms,
            totalRequests: result.requests.total,
            errors: result.errors,
            non2xx: result.non2xx,
            timeouts: result.timeouts,
        });
        evaluations.push(evaluation);
        console.log(
            `  req/sec avg=${result.requests.average}  p95~=${p95Ms}ms  `
            + `errors=${result.errors} non2xx=${result.non2xx} timeouts=${result.timeouts}  `
            + `${evaluation.pass ? 'PASS' : 'FAIL'}`
        );
    }

    server.kill();

    const summary = summarizeThroughputRun(evaluations);
    console.log('\n--- Throughput test summary ---');
    console.log(`Endpoints: ${summary.totalEndpoints}  Passed: ${summary.passed}  Failed: ${summary.failed}`);
    if (!summary.allPassed) {
        for (const violation of summary.violations) console.log(`  - ${violation}`);
    }

    process.exitCode = summary.allPassed ? 0 : 1;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
