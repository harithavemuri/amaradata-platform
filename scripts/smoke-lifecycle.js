#!/usr/bin/env node
'use strict';

/**
 * Wraps scripts/smoke-prod.js with an enable-before/disable-after lifecycle
 * for the smoke-test account, using the existing PUT /api/admin/users/:id
 * route (no new Lambda / raw-SQL mechanism — unlike rohas-group's approach,
 * amaradata already exposes this over its normal admin API).
 *
 * Requires a permanent site_admin "bootstrap" account (SMOKE_BOOTSTRAP_ADMIN_*)
 * that is never itself the account being toggled — see .env.test.example.
 *
 * Usage:
 *   node -r dotenv/config scripts/smoke-lifecycle.js dotenv_config_path=.env.test
 *   npm run smoke:lifecycle
 */
const { spawnSync } = require('child_process');
const path          = require('path');

// Load .env.test explicitly — `-r dotenv/config` alone only loads .env.
// override:true is required: .env also defines SMOKE_TEST_USER/PASSWORD (for
// standalone `npm run smoke` convenience) and dotenv does not replace already-
// set vars by default, so without this the -r dotenv/config preload's .env
// values would silently win and the spawned smoke-prod.js child would
// authenticate with the wrong (stale) password.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true });

const BASE            = (process.env.SMOKE_URL || 'https://amaradata.com').replace(/\/$/, '');
const BOOT_USER        = process.env.SMOKE_BOOTSTRAP_ADMIN_USER;
const BOOT_PASSWORD    = process.env.SMOKE_BOOTSTRAP_ADMIN_PASSWORD;
const SMOKE_USER       = process.env.SMOKE_TEST_USER;
const SMOKE_PASSWORD   = process.env.SMOKE_TEST_ADMIN_PASSWORD;

if (!BOOT_USER || !BOOT_PASSWORD) {
    console.error('Set SMOKE_BOOTSTRAP_ADMIN_USER / SMOKE_BOOTSTRAP_ADMIN_PASSWORD (in .env.test) before running.');
    process.exit(1);
}
if (!SMOKE_USER || !SMOKE_PASSWORD) {
    console.error('Set SMOKE_TEST_USER / SMOKE_TEST_ADMIN_PASSWORD (in .env.test) before running.');
    process.exit(1);
}

async function loginBootstrap() {
    const res  = await fetch(`${BASE}/api/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json;v=1' },
        body:    JSON.stringify({ username: BOOT_USER, password: BOOT_PASSWORD }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.token) {
        throw new Error(`Bootstrap login failed: HTTP ${res.status} — ${json.error || 'no token in response'}`);
    }
    return json.token;
}

async function findSmokeUserId(token) {
    const res  = await fetch(`${BASE}/api/admin/users`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json;v=1' },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET /api/admin/users failed: HTTP ${res.status} — ${json.error || ''}`);
    const user = (json.data || []).find(u => u.username === SMOKE_USER);
    if (!user) throw new Error(`Smoke user "${SMOKE_USER}" not found via /api/admin/users — cannot manage its lifecycle.`);
    return user.id;
}

async function setActive(token, userId, active) {
    const res  = await fetch(`${BASE}/api/admin/users/${userId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'application/json;v=1' },
        body:    JSON.stringify({ is_active: active }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PUT /api/admin/users/${userId} (is_active=${active}) failed: HTTP ${res.status} — ${json.error || ''}`);
}

async function assertCannotLogin() {
    const res = await fetch(`${BASE}/api/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json;v=1' },
        body:    JSON.stringify({ username: SMOKE_USER, password: SMOKE_PASSWORD }),
    });
    if (res.ok) {
        console.error(`  ✗  Disabled smoke user "${SMOKE_USER}" was still able to log in — teardown did not take effect!`);
        return false;
    }
    console.log(`  ✓  Disabled smoke user "${SMOKE_USER}" correctly rejected at login (HTTP ${res.status})`);
    return true;
}

async function main() {
    console.log(`=== Smoke lifecycle — enabling "${SMOKE_USER}" ===`);
    let userId;
    {
        const token = await loginBootstrap();
        userId = await findSmokeUserId(token);
        await setActive(token, userId, true);
    }
    console.log(`  ✓  "${SMOKE_USER}" enabled.`);

    console.log('\n=== Running scripts/smoke-prod.js ===');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'smoke-prod.js')], {
        stdio: 'inherit',
        env:   process.env,
    });
    const smokeExitCode = result.status ?? 1;

    console.log(`\n=== Smoke lifecycle — disabling "${SMOKE_USER}" ===`);
    let teardownOk = true;
    try {
        // Re-login: the bootstrap JWT is only 15 minutes, but smoke.js is usually
        // fast — re-authenticating here is cheap insurance regardless.
        const token = await loginBootstrap();
        await setActive(token, userId, false);
        console.log(`  ✓  "${SMOKE_USER}" disabled.`);
        teardownOk = await assertCannotLogin();
    } catch (e) {
        console.error(`  ✗  Teardown failed: ${e.message}`);
        console.error(`  !  "${SMOKE_USER}" may still be enabled in production — investigate manually.`);
        teardownOk = false;
    }

    if (smokeExitCode !== 0) {
        console.error('\nSmoke checks FAILED.');
        process.exit(smokeExitCode);
    }
    if (!teardownOk) {
        console.error('\nSmoke checks passed but teardown had a problem — treat this run as failed.');
        process.exit(1);
    }
    console.log('\nSmoke lifecycle complete — all checks passed, account disabled.');
}

main().catch(e => {
    console.error('[smoke-lifecycle] Fatal error:', e.message);
    process.exit(1);
});
