#!/usr/bin/env node
/**
 * Shared start/wait-for-ready logic for the local regression test server
 * (port 9001), used by both scripts/run-load-test.js (concurrency-correctness
 * load test) and scripts/run-throughput-test.js (autocannon throughput/
 * capacity test) — factored out so the two don't duplicate the same spawn +
 * health-poll logic.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PORT = 9001;
const HEALTH_URL = `http://localhost:${SERVER_PORT}/api/site-config`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {'db'|'nondb'} mode */
function startServer(mode) {
    const script = mode === 'db' ? 'start-server-db.js' : 'server-entry.js';
    const child = spawn(process.execPath, [path.join(ROOT, 'testing/regression_testsuite', script)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    return child;
}

async function waitForServerReady(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(HEALTH_URL);
            if (res.ok) return true;
        } catch { /* not up yet */ }
        await sleep(300);
    }
    return false;
}

module.exports = { startServer, waitForServerReady, SERVER_PORT, HEALTH_URL, ROOT };
