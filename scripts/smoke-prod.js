#!/usr/bin/env node
'use strict';

/**
 * Production API smoke test — READ-only, DB mode.
 *
 * Usage:
 *   SMOKE_TEST_USER=smoketest_admin SMOKE_TEST_ADMIN_PASSWORD=secret node scripts/smoke-prod.js
 *
 * Options (env vars):
 *   SMOKE_URL                  Base URL (default: https://amaradata.com)
 *   SMOKE_TEST_USER            Login username (required)
 *   SMOKE_TEST_ADMIN_PASSWORD  Login password (required)
 *   SMOKE_VERBOSE              Set to '1' for full response bodies
 */

const BASE     = (process.env.SMOKE_URL || 'https://amaradata.com').replace(/\/$/, '');
const USERNAME = process.env.SMOKE_TEST_USER;
const PASS     = process.env.SMOKE_TEST_ADMIN_PASSWORD;
const VERBOSE  = process.env.SMOKE_VERBOSE === '1';

if (!USERNAME || !PASS) {
    console.error('Set SMOKE_TEST_USER and SMOKE_TEST_ADMIN_PASSWORD before running.');
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

async function getHtml(path) {
    const res = await fetch(`${BASE}${path}`, { headers: { 'Accept': 'text/html' } });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type') || '', text };
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
    console.log(`   User:   ${USERNAME}\n`);

    // ── 1. health check ──────────────────────────────────────────────────────
    const health = await get('/health');
    check('GET /health → 200', health.status === 200, `HTTP ${health.status}`);
    check('/health returns { ok: true }', health.json?.ok === true, JSON.stringify(health.json));
    check('/health returns version string', typeof health.json?.version === 'string' && health.json.version.length > 0, health.json?.version);

    // ── 2. site-config ───────────────────────────────────────────────────────
    const sc = await get('/api/site-config');
    check('GET /api/site-config → 200', sc.status === 200, `HTTP ${sc.status}`);
    check('/api/site-config has companyName', !!sc.json?.companyName, sc.json?.companyName);

    // ── 3. login ──────────────────────────────────────────────────────────────
    const login = await post('/api/auth/login', { username: USERNAME, password: PASS });
    check('POST /api/auth/login → 200', login.status === 200, `HTTP ${login.status}`);
    const token = login.json?.token;
    check('Login returns access token', !!token);
    if (!token) { printResults(); process.exit(1); }

    // ── 4. admin health page (HTML) ───────────────────────────────────────────
    const ahPage = await getHtml('/admin-health');
    check('GET /admin-health → 200',       ahPage.status === 200, `HTTP ${ahPage.status}`);
    check('/admin-health returns HTML',    ahPage.contentType.includes('text/html'), ahPage.contentType.split(';')[0]);
    check('/admin-health contains <body>', ahPage.text.includes('<body>'), ahPage.text.length > 0 ? 'has content' : 'empty');

    // ── 5. admin health API — version matrix + table data ─────────────────────
    const ah = await get('/api/admin/health', token);
    check('GET /api/admin/health → 200', ah.status === 200, `HTTP ${ah.status}`);
    if (ah.status === 200) {
        const v = ah.json?.data?.versions;
        check('/api/admin/health has api version',  typeof v?.api === 'string' && v.api.length > 0, v?.api);
        check('/api/admin/health has ui version',   typeof v?.ui === 'string'  && v.ui.length  > 0, v?.ui);
        check('/api/admin/health has db version',   typeof v?.db === 'string'  && v.db.length  > 0, v?.db);
        check('/health and admin/health api versions match', v?.api === health.json?.version,
            `health=${health.json?.version} admin=${v?.api}`);
        if (VERBOSE) console.log('     versions:', JSON.stringify(v));

        // Reference/config tables must have data; transaction tables are allowed to be empty
        const tables = ah.json?.data?.tables || {};
        const TRANSACTION_TABLES = new Set([
            'invoices', 'invoice_line_items', 'billing_metrics', 'payments',
            'enhancements', 'contact_submissions', 'tenant_subscriptions',
            'amr_group_members', 'group_tenant', 'amr_password_reset_tokens',
            // groups are admin-created, may be empty in a fresh environment
            'amr_groups',
            // deprecated — tables remain in schema but are intentionally empty
            'amr_user_groups', 'amr_user_group_members',
        ]);
        for (const [table, n] of Object.entries(tables)) {
            if (TRANSACTION_TABLES.has(table)) continue;
            check(`Table ${table} has data`, n > 0, `rows=${n}`);
        }
        if (VERBOSE) console.log('     tables:', JSON.stringify(tables));
    }

    // ── 6. read-only API endpoints ────────────────────────────────────────────

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

    // ── 7. Content-Type guard (CloudFront CustomErrorResponses check) ─────────
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
