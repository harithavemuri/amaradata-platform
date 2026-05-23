#!/usr/bin/env node
/**
 * AmaraData Platform CLI
 *
 * Commands:
 *   export-db [table1,table2,...]   Export DB tables to transactiondata/ JSON files
 *   serve-nondb                     Start server in NonDB (file-based) mode
 *   check-db                        Test database connectivity
 *   stats                           Print row counts for all tables
 *   sync [--dry-run]                Import transactiondata/ JSON files into DB
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const [,, cmd, ...args] = process.argv;

switch (cmd) {
    case 'export-db':
        process.argv = [process.argv[0], process.argv[1], args[0]].filter(Boolean);
        require('../jobs/export-db-to-files');
        break;

    case 'serve-nondb':
        process.env.NONDB_MODE = 'true';
        require('../server');
        console.log('[NonDB mode] Using file-based data from transactiondata/');
        break;

    case 'check-db':
        checkDb();
        break;

    case 'stats':
        printStats();
        break;

    case 'sync':
        syncToDb(args.includes('--dry-run'));
        break;

    default:
        console.log(`
AmaraData Platform CLI

Commands:
  export-db [tables]   Export DB → transactiondata/ JSON files
  serve-nondb          Start server in file-based mode (no DB required)
  check-db             Test database connectivity
  stats                Print row counts for all tables
  sync [--dry-run]     Import transactiondata/ JSON files into DB
`);
}

async function checkDb() {
    const db = require('../backend/db');
    try {
        const { rows } = await db.query('SELECT NOW() AS now');
        console.log('DB connection OK:', rows[0].now);
        process.exit(0);
    } catch (e) {
        console.error('DB connection FAILED:', e.message);
        process.exit(1);
    }
}

async function printStats() {
    const db       = require('../backend/db');
    const manifest = require('../metadata/manifest.json');
    console.log('\nRow counts:\n');
    for (const table of manifest.tables) {
        try {
            const { rows: [{ count }] } = await db.query(`SELECT COUNT(*) FROM ${table}`);
            console.log(`  ${table.padEnd(30)} ${count}`);
        } catch (e) {
            console.log(`  ${table.padEnd(30)} ERROR: ${e.message}`);
        }
    }
    console.log('');
    process.exit(0);
}

async function syncToDb(dryRun) {
    const fs       = require('fs');
    const path     = require('path');
    const db       = require('../backend/db');
    const manifest = require('../metadata/manifest.json');
    const DATA_DIR = process.env.TRANSACTIONDATA_DIR
        ? path.resolve(process.env.TRANSACTIONDATA_DIR)
        : path.join(__dirname, '../transactiondata');

    if (dryRun) console.log('[dry-run] No changes will be written.\n');

    for (const table of manifest.tables) {
        const file = path.join(DATA_DIR, `${table}.json`);
        if (!fs.existsSync(file)) { console.log(`  skip ${table} (no file)`); continue; }
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`  ${table}: ${rows.length} rows`);
        if (!dryRun && rows.length > 0) {
            console.log(`    (sync not implemented — use psql COPY or a migration tool for bulk import)`);
        }
    }

    if (!dryRun) console.log('\nSync complete (inspect output above).');
    process.exit(0);
}
