#!/usr/bin/env node
'use strict';

/**
 * Production API smoke test — READ-only, DB mode.
 *
 * Usage:
 *   SMOKE_EMAIL=you@amaradata.com SMOKE_PASSWORD=secret node scripts/smoke-prod.js
 *
 * Options (env vars):
 *   SMOKE_URL       Base URL (default: https://amaradata.com)
 *   SMOKE_EMAIL     Login email (required)
 *   SMOKE_PASSWORD  Login password (required)
 *   SMOKE_VERBOSE   Set to '1' for full response bodies
 */

const BASE  = (process.env.SMOKE_URL || 'https://amaradata.com').replace(/\/$/, '');
const EMAIL = process.env.SMOKE_EMAIL;
const PASS  = process.env.SMOKE_PASSWORD;
const VERBOSE = process.env.SMOKE_VERBOSE === '1';

if (!EMAIL || !PASS) {
    console.error('Set SMOKE_EMAIL and SMOKE_PASSWORD before running.');
    process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json;v=1' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
}

async function get(path, token) {
    const headers = { 'Accept': 'application/json;v=1' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}${path}`, { headers });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
}

// ─── test runner ──────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const results = [];

function check(label, ok, detail) {
    const sym = ok ? '✓' : '✗';
    const line = `  ${sym}  ${label}${detail ? `  (${detail})` : ''}`;
    results.push({ ok, line });
    if (ok) pass++; else fail++;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n── AmaraData Production Smoke Test ──`);
    console.log(`   Target: ${BASE}`);
    console.log(`   User:   ${EMAIL}\n`);

    // ── 1. health check ──────────────────────────────────────────────────────
    const health = await get('/health');
    check('GET /health → 200', health.status === 200, `HTTP ${health.status}`);
    check('/health returns { status: "ok" }', health.json?.status === 'ok', health.json?.status);

    // ── 2. site-config ───────────────────────────────────────────────────────
    const sc = await get('/api/site-config');
    check('GET /api/site-config → 200', sc.status === 200, `HTTP ${sc.status}`);
    check('/api/site-config has dbMode field', 'dbMode' in (sc.json || {}));

    const dbMode = sc.json?.dbMode;
    check('/api/site-config dbMode is "db" (not nondb)', dbMode === 'db', `dbMode=${dbMode}`);

    // ── 3. login ──────────────────────────────────────────────────────────────
    const login = await post('/api/auth/login', { email: EMAIL, password: PASS });
    check('POST /api/auth/login → 200', login.status === 200, `HTTP ${login.status}`);
    const token = login.json?.data?.token;
    check('Login returns access token', !!token);
    if (!token) { printResults(); process.exit(1); }

    // ── 4. read-only API endpoints ────────────────────────────────────────────

    const ENDPOINTS = [
        { path: '/api/tenants',              label: 'GET /api/tenants' },
        { path: '/api/subscriptions/plans',  label: 'GET /api/subscriptions/plans' },
        { path: '/api/invoices',             label: 'GET /api/invoices' },
        { path: '/api/enhancements',         label: 'GET /api/enhancements' },
        { path: '/api/metrics',              label: 'GET /api/metrics' },
        { path: '/api/contact',              label: 'GET /api/contact' },
        { path: '/api/admin/users',          label: 'GET /api/admin/users' },
        { path: '/api/admin/user-groups',    label: 'GET /api/admin/user-groups' },
        { path: '/api/admin/roles',          label: 'GET /api/admin/roles' },
    ];

    for (const { path, label } of ENDPOINTS) {
        const r = await get(path, token);
        const ok = r.status === 200;
        const data = r.json?.data;
        const count = Array.isArray(data) ? data.length : (data != null ? '(object)' : 'n/a');
        check(`${label} → 200`, ok, `HTTP ${r.status}`);
        if (ok) {
            check(`${label} returns { success: true }`, r.json?.success === true);
            check(`${label} data is present`, data != null, `rows=${count}`);
            if (VERBOSE) console.log(`     data:`, JSON.stringify(data).slice(0, 200));
        }
    }

    // ── 5. table existence spot-check via admin stats ─────────────────────────
    // Hit db-migrate-style checks by looking at the /api/admin/user-groups response
    const ugr = await get('/api/admin/user-groups', token);
    check('amr_user_groups table exists (no 500)', ugr.status !== 500,
        ugr.status === 500 ? (ugr.json?.error || 'table missing?') : `HTTP ${ugr.status}`);

    const rolesR = await get('/api/admin/roles', token);
    check('amr_roles table exists (no 500)', rolesR.status !== 500,
        rolesR.status === 500 ? (rolesR.json?.error || 'table missing?') : `HTTP ${rolesR.status}`);

    // ── 6. Content-Type guard (CloudFront CustomErrorResponses check) ─────────
    for (const path of ['/api/tenants', '/api/admin/users']) {
        const res = await fetch(`${BASE}${path}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json;v=1' },
        });
        const ct = res.headers.get('content-type') || '';
        check(`${path} Content-Type is application/json (not HTML)`,
            ct.includes('application/json'),
            ct.split(';')[0]);
    }

    printResults();
    process.exit(fail > 0 ? 1 : 0);
}

function printResults() {
    console.log('\n── Results ──────────────────────────────────────────────────');
    for (const { line } of results) console.log(line);
    console.log(`\n   ${pass} passed, ${fail} failed\n`);
}

main().catch(err => {
    console.error('\n[smoke] Fatal error:', err.message);
    process.exit(1);
});
