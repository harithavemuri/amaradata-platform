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
 *   the prod DB directly from a local machine. Instead it reads the same
 *   sibling-repo CSVs jobs/sync-tenant-fixes.js scans locally, groups
 *   eligible rows by tenant (reusing that job's exported parseCsv/
 *   extractEligibleRows/groupByTenant/findResultCsvs), and — only with
 *   --yes — POSTs each tenant's rows straight to the already-deployed
 *   POST /api/enhancements/import (same route + upsert semantics
 *   jobs/sync-tenant-fixes.js's own DB-mode path uses, and the same route
 *   the CSV importer on the Enhancements screen uses), which already has
 *   VPC access. This is a real, persistent write to a live database, hence
 *   --yes is required; without it, this only prints what would be pushed.
 *
 * Usage:
 *   node scripts/seed-enhancements.js --target=local
 *   node scripts/seed-enhancements.js --target=production          (dry-run preview)
 *   node scripts/seed-enhancements.js --target=production --yes    (actually pushes to prod)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const {
    findResultCsvs, parseCsv, extractEligibleRows, groupByTenant,
} = require('../jobs/sync-tenant-fixes.js');

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

// Scans the same sibling-repo CSVs sync-tenant-fixes.js does, and groups
// eligible rows by tenant name — the shared first step for both the preview
// and the actual --yes push below.
function collectRowsByTenant() {
    const csvFiles = findResultCsvs();
    const byTenant  = {};
    let unmatchedCount = 0;

    for (const csvPath of csvFiles) {
        const rows     = parseCsv(fs.readFileSync(csvPath, 'utf8'));
        const eligible = extractEligibleRows(rows);
        unmatchedCount += eligible.filter(r => !r.tenant_name).length;

        const grouped = groupByTenant(eligible.filter(r => r.tenant_name));
        for (const [tenantName, tenantRows] of Object.entries(grouped)) {
            (byTenant[tenantName] ||= []).push(...tenantRows);
        }
    }
    return { byTenant, unmatchedCount, csvCount: csvFiles.length };
}

async function runProduction() {
    const { byTenant, unmatchedCount, csvCount } = collectRowsByTenant();

    if (!csvCount) {
        console.log('No tenant results CSVs found — nothing to sync.');
        return;
    }
    if (unmatchedCount) {
        console.log(`! ${unmatchedCount} row(s) skipped across all CSVs — no Tenant Name column value.`);
    }

    if (!confirmed) {
        console.log('=== Dry run — nothing pushed (pass --yes to actually sync to production) ===');
        for (const [tenantName, rows] of Object.entries(byTenant)) {
            console.log(`  ${tenantName}: ${rows.length} row(s) would be synced`);
        }
        console.log('\nRe-run with --yes to push these to the production database:');
        console.log('  node scripts/seed-enhancements.js --target=production --yes');
        return;
    }

    require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
    const BASE          = (process.env.SMOKE_URL || 'https://amaradata.com').replace(/\/$/, '');
    const BOOT_USER      = process.env.SMOKE_BOOTSTRAP_ADMIN_USER;
    const BOOT_PASSWORD  = process.env.SMOKE_BOOTSTRAP_ADMIN_PASSWORD;
    if (!BOOT_USER || !BOOT_PASSWORD) {
        console.error('Set SMOKE_BOOTSTRAP_ADMIN_USER / SMOKE_BOOTSTRAP_ADMIN_PASSWORD in .env.test before running --target=production --yes.');
        process.exit(1);
    }

    console.log(`=== Pushing to production DB via ${BASE}/api/enhancements/import ===`);
    const loginRes  = await fetch(`${BASE}/api/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json;v=1' },
        body:    JSON.stringify({ username: BOOT_USER, password: BOOT_PASSWORD }),
    });
    const loginJson = await loginRes.json().catch(() => ({}));
    if (!loginRes.ok || !loginJson?.token) {
        throw new Error(`Bootstrap login failed: HTTP ${loginRes.status} — ${loginJson.error || 'no token in response'}`);
    }

    for (const [tenantName, rows] of Object.entries(byTenant)) {
        const res  = await fetch(`${BASE}/api/enhancements/import`, {
            method:  'POST',
            headers: {
                Authorization:  `Bearer ${loginJson.token}`,
                'Content-Type': 'application/json',
                Accept:         'application/json;v=1',
            },
            body: JSON.stringify({ tenant_name: tenantName, rows }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            console.error(`  ${tenantName}: FAILED — HTTP ${res.status} — ${json.error || ''}`);
            continue;
        }
        const d = json.data || {};
        console.log(`  ${tenantName}: ${d.inserted || 0} inserted, ${d.updated || 0} updated, ${d.skipped || 0} skipped`
            + (d.errors?.length ? `, ${d.errors.length} errors` : ''));
    }
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
