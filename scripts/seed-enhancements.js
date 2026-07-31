#!/usr/bin/env node
'use strict';

/**
 * Wraps jobs/sync-tenant-fixes.js with an explicit --target flag, mirroring
 * rohas-group's scripts/apply-local-migrations.py pattern of one script that
 * can point at a real (non-_test) local DB or a live deployed environment,
 * instead of leaving the destination to whatever .env happens to be loaded.
 *
 * --target=local (default): connects directly to the local Postgres DB
 *   (via .env's AMRD_DB_* creds) and upserts tenant CSV rows into
 *   enhancements — same as `node jobs/sync-tenant-fixes.js` without
 *   NONDB_MODE. Safe to re-run (upsert keyed on tenant_id+issue_id).
 *
 * --target=production: RDS is VPC-only and never publicly accessible (see
 *   .project-constraints / feedback-db-security) — this can NEVER connect to
 *   the prod DB directly from a local machine. Instead it (1) regenerates
 *   transactiondata/enhancements.json locally from the tenant CSVs, then
 *   (2) calls the already-deployed POST /api/admin/sync-to-db endpoint —
 *   the same Lambda-mediated sync the admin UI's "Sync to DB" button uses,
 *   which already has VPC access. Step 2 only picks up data that has
 *   actually been committed + deployed, since it reads the LIVE SERVER'S
 *   OWN bundled transactiondata/*.json, not this machine's files, so it is
 *   a no-op until the regenerated JSON is deployed first. Requires --yes —
 *   this is a real, persistent write to a live database.
 *
 * Usage:
 *   node scripts/seed-enhancements.js --target=local
 *   node scripts/seed-enhancements.js --target=production          (regenerates JSON only)
 *   node scripts/seed-enhancements.js --target=production --yes    (also pushes to prod)
 */

const { spawnSync } = require('child_process');
const path = require('path');

const args      = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--target='));
const target    = targetArg ? targetArg.split('=')[1] : 'local';
const confirmed = args.includes('--yes');

if (!['local', 'production'].includes(target)) {
    console.error(`Unknown --target=${target}. Use "local" or "production".`);
    process.exit(1);
}

// Forward any extra flags (e.g. --dry-run) straight through to sync-tenant-fixes.js.
const passthroughArgs = args.filter(a => a !== '--yes' && !a.startsWith('--target='));

function runSyncJob(nonDb) {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'jobs', 'sync-tenant-fixes.js'), ...passthroughArgs], {
        stdio: 'inherit',
        env:   { ...process.env, NONDB_MODE: nonDb ? 'true' : 'false' },
    });
}

async function runProduction() {
    console.log('=== Regenerating transactiondata/enhancements.json from tenant CSVs ===');
    const genResult = runSyncJob(true);
    if ((genResult.status ?? 1) !== 0) {
        console.error('Regeneration failed — aborting before touching production.');
        process.exit(1);
    }

    console.log('\ntransactiondata/enhancements.json has been regenerated locally.');
    console.log('It must be committed and deployed (npm run deploy) BEFORE the production');
    console.log('sync below does anything useful — /api/admin/sync-to-db reads the LIVE');
    console.log("SERVER'S OWN bundled transactiondata files, not this machine's.");

    if (!confirmed) {
        console.log('\nRe-run with --yes once the updated file is committed and deployed, to');
        console.log('push it into the production database:');
        console.log('  node scripts/seed-enhancements.js --target=production --yes');
        return;
    }

    require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
    const BASE         = (process.env.SMOKE_URL || 'https://amaradata.com').replace(/\/$/, '');
    const BOOT_USER     = process.env.SMOKE_BOOTSTRAP_ADMIN_USER;
    const BOOT_PASSWORD = process.env.SMOKE_BOOTSTRAP_ADMIN_PASSWORD;
    if (!BOOT_USER || !BOOT_PASSWORD) {
        console.error('Set SMOKE_BOOTSTRAP_ADMIN_USER / SMOKE_BOOTSTRAP_ADMIN_PASSWORD in .env.test before running --target=production --yes.');
        process.exit(1);
    }

    console.log(`\n=== Pushing to production DB via ${BASE}/api/admin/sync-to-db ===`);
    const loginRes  = await fetch(`${BASE}/api/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json;v=1' },
        body:    JSON.stringify({ username: BOOT_USER, password: BOOT_PASSWORD }),
    });
    const loginJson = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || !loginJson?.token) {
        throw new Error(`Bootstrap login failed: HTTP ${loginRes.status} — ${loginJson.error || 'no token in response'}`);
    }

    const syncRes  = await fetch(`${BASE}/api/admin/sync-to-db`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${loginJson.token}`, Accept: 'application/json;v=1' },
    });
    const syncJson = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok) {
        throw new Error(`POST /api/admin/sync-to-db failed: HTTP ${syncRes.status} — ${syncJson.error || ''}`);
    }
    console.log(JSON.stringify(syncJson, null, 2));
    console.log('\nProduction sync complete.');
}

if (target === 'local') {
    console.log('=== Seeding enhancements: LOCAL Postgres DB ===');
    process.exit(runSyncJob(false).status ?? 1);
} else {
    runProduction().catch(e => {
        console.error('[seed-enhancements]', e.message);
        process.exit(1);
    });
}
