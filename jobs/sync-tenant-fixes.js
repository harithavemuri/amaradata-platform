/**
 * Scans every sibling tenant repo for a release-tracking results CSV
 * (testing/release-tracking/*.csv) and upserts eligible rows into the
 * enhancements table, so tenant bug/enhancement work is visible and
 * billable in the AmaraData Enhancements screen.
 *
 * Mirrors the upsert semantics of POST /api/enhancements/import (same
 * unique key: tenant_id + issue_id) but runs standalone, without a
 * running server — same pattern as jobs/export-db-to-files.js.
 *
 * Run: node jobs/sync-tenant-fixes.js [--dry-run]
 * Or:  npm run sync-tenant-fixes
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');

const DRY_RUN     = process.argv.includes('--dry-run');
const TENANTS_ROOT = process.env.TENANTS_ROOT
    ? path.resolve(process.env.TENANTS_ROOT)
    : path.join(__dirname, '..', '..'); // siblings of amaradata-platform, e.g. C:\Haritha\github

function findResultCsvs() {
    const found = [];
    if (!fs.existsSync(TENANTS_ROOT)) return found;
    for (const entry of fs.readdirSync(TENANTS_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === path.basename(path.join(__dirname, '..'))) continue;
        const dir = path.join(TENANTS_ROOT, entry.name, 'testing', 'release-tracking');
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            if (file.toLowerCase().endsWith('.csv')) found.push(path.join(dir, file));
        }
    }
    return found;
}

// Quote-aware CSV line splitter — same algorithm as frontend/enhancements.html's splitCsvLine()
function splitCsvLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
        else cur += ch;
    }
    result.push(cur);
    return result;
}

function normalizeHeader(h) {
    return h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/[\s?]+/g, '_');
}

function parseCsv(text) {
    const lines  = text.replace(/\r\n/g, '\n').trim().split('\n');
    const header = splitCsvLine(lines[0]).map(normalizeHeader);
    const rows   = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        if (!cells.length || cells.every(c => !c.trim())) continue;
        const row = {};
        header.forEach((h, idx) => { row[h] = (cells[idx] || '').trim().replace(/^"|"$/g, ''); });
        rows.push(row);
    }
    return rows;
}

// Same eligibility rule as the existing browser importer (enhancements.html importCsv()):
// Apply Fix? = Yes. Fixed?/status is carried through, not used as an inclusion filter —
// an unfinished item still shows up (as status=scoped) so it's visible, just not billed as delivered.
function extractEligibleRows(csvRows) {
    return csvRows
        .filter(r => (r.apply_fix_ || '').toLowerCase() === 'yes')
        .map(r => ({
            issue_id:    Number(r.issueid) || null,
            report_date: r.report_date || null,
            notes:       r.notes || '',
            fix_details: r.fix_details || '',
            // 'Task' rows are always enhancements (billable work), matching .claude/skills/fix-issues.md's rule
            item_type:   (r.type || '').toLowerCase() === 'bug' ? 'bug' : 'enhancement',
            is_billable: (r.billable || '').toLowerCase() === 'yes',
            fixed:       r.fixed_ || '',
            site_name:   r.site_name || '',
            tenant_name: r.tenant_name || null,
        }))
        .filter(r => r.issue_id);
}

function groupByTenant(rows) {
    const byTenant = {};
    for (const r of rows) {
        const key = r.tenant_name || '__unmatched__';
        if (!byTenant[key]) byTenant[key] = [];
        byTenant[key].push(r);
    }
    return byTenant;
}

async function upsertGroupDb(db, tenantName, rows) {
    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    const { rows: tRows } = await db.query('SELECT id FROM tenants WHERE lower(name)=lower($1) LIMIT 1', [tenantName]);
    if (!tRows[0]) {
        results.skipped = rows.length;
        results.errors.push(`Tenant "${tenantName}" not found in tenants table`);
        return results;
    }
    const tenantId = tRows[0].id;
    for (const r of rows) {
        const title     = (r.notes || '').slice(0, 200) || `Issue #${r.issue_id}`;
        const delivered = r.fixed.toLowerCase().startsWith('yes') ? (r.report_date || null) : null;
        const status    = r.fixed.toLowerCase().startsWith('yes') ? 'delivered'
                         : r.fixed.toLowerCase().startsWith('skip') ? 'cancelled' : 'scoped';
        if (DRY_RUN) { results.inserted++; continue; }
        try {
            const { rows: ins } = await db.query(
                `INSERT INTO enhancements
                 (tenant_id,title,description,billing_type,status,delivered_at,notes,
                  source,issue_id,site_name,fixed,item_type,is_billable,report_date)
                 VALUES ($1,$2,$3,'fixed',$4,$5,$6,'csv',$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (tenant_id,issue_id) DO UPDATE SET
                   title=EXCLUDED.title, description=EXCLUDED.description,
                   notes=EXCLUDED.notes, item_type=EXCLUDED.item_type,
                   is_billable=EXCLUDED.is_billable, fixed=EXCLUDED.fixed,
                   site_name=EXCLUDED.site_name, status=EXCLUDED.status,
                   delivered_at=EXCLUDED.delivered_at, report_date=EXCLUDED.report_date,
                   updated_at=NOW()
                 RETURNING (xmax = 0) AS inserted`,
                [tenantId, title, r.notes, status, delivered, r.fix_details || null,
                 r.issue_id, r.site_name || null, r.fixed || null,
                 r.item_type, r.is_billable, r.report_date || null]
            );
            ins[0]?.inserted ? results.inserted++ : results.updated++;
        } catch (e) {
            results.errors.push({ issue_id: r.issue_id, error: e.message });
        }
    }
    return results;
}

function upsertGroupFile(fileDb, tenantName, rows) {
    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    const tenant = fileDb.find('tenants').find(t => t.name.toLowerCase() === tenantName.toLowerCase());
    if (!tenant) {
        results.skipped = rows.length;
        results.errors.push(`Tenant "${tenantName}" not found in tenants table`);
        return results;
    }
    for (const r of rows) {
        const title     = (r.notes || '').slice(0, 200) || `Issue #${r.issue_id}`;
        const delivered = r.fixed.toLowerCase().startsWith('yes') ? (r.report_date || null) : null;
        const status    = r.fixed.toLowerCase().startsWith('yes') ? 'delivered'
                         : r.fixed.toLowerCase().startsWith('skip') ? 'cancelled' : 'scoped';
        const existing = fileDb.find('enhancements').find(e => e.tenant_id == tenant.id && e.issue_id == r.issue_id);
        if (DRY_RUN) { existing ? results.updated++ : results.inserted++; continue; }
        if (existing) {
            fileDb.update('enhancements', existing.id, {
                title, description: r.notes, notes: r.fix_details || null,
                item_type: r.item_type, is_billable: r.is_billable, fixed: r.fixed || null,
                site_name: r.site_name || null, status, delivered_at: delivered,
                report_date: r.report_date || null,
            });
            results.updated++;
        } else {
            fileDb.create('enhancements', {
                tenant_id: tenant.id, title, description: r.notes, notes: r.fix_details || null,
                billing_type: 'fixed', status,
                estimated_hours: null, actual_hours: null, hourly_rate: null,
                milestone_amount: null, delivered_at: delivered, invoice_id: null,
                source: 'csv', issue_id: r.issue_id,
                site_name: r.site_name || null, fixed: r.fixed || null,
                item_type: r.item_type, is_billable: r.is_billable,
                report_date: r.report_date || null,
            });
            results.inserted++;
        }
    }
    return results;
}

async function main() {
    const csvFiles = findResultCsvs();
    if (!csvFiles.length) {
        console.log(`No tenant results CSVs found under ${TENANTS_ROOT}\\<tenant>\\testing\\release-tracking\\*.csv`);
        return;
    }

    const nonDb = process.env.NONDB_MODE === 'true';
    const db     = nonDb ? null : require('../backend/db');
    const FileDb = nonDb ? require('../backend/services/file-db-service') : null;
    const fileDb = nonDb ? new FileDb() : null;

    console.log(`Mode: ${nonDb ? 'NonDB (file-based)' : 'DB'}${DRY_RUN ? '  [dry-run]' : ''}`);

    for (const csvPath of csvFiles) {
        const tenantFolder = path.basename(path.join(path.dirname(csvPath), '..', '..'));
        console.log(`\n=== ${tenantFolder}: ${csvPath} ===`);

        const rows      = parseCsv(fs.readFileSync(csvPath, 'utf8'));
        const eligible   = extractEligibleRows(rows);
        const unmatched  = eligible.filter(r => !r.tenant_name);
        const byTenant   = groupByTenant(eligible.filter(r => r.tenant_name));

        if (unmatched.length) {
            console.log(`  ! ${unmatched.length} row(s) skipped — no Tenant Name column value: issue_id(s) ${unmatched.map(r => r.issue_id).join(', ')}`);
        }

        for (const [tenantName, tenantRows] of Object.entries(byTenant)) {
            const result = nonDb
                ? upsertGroupFile(fileDb, tenantName, tenantRows)
                : await upsertGroupDb(db, tenantName, tenantRows);
            console.log(`  ${tenantName}: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped`);
            if (result.errors.length) console.log(`    errors: ${JSON.stringify(result.errors)}`);
        }
    }

    if (!nonDb) process.exit(0);
}

if (require.main === module) {
    main().catch(e => { console.error('[sync-tenant-fixes]', e.message); process.exit(1); });
}

module.exports = { splitCsvLine, normalizeHeader, parseCsv, extractEligibleRows, groupByTenant };
