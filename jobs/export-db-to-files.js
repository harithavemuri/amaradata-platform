/**
 * Exports all platform DB tables to JSON files in transactiondata/.
 * Used to seed NonDB mode from a live database.
 *
 * Run: node jobs/export-db-to-files.js [table1,table2,...]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const db   = require('../backend/db');

const MANIFEST   = require('../metadata/manifest.json');
const OUTPUT_DIR = process.env.TRANSACTIONDATA_DIR
    ? path.resolve(process.env.TRANSACTIONDATA_DIR)
    : path.join(__dirname, '../transactiondata');

async function exportTable(table) {
    const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY id`);
    const file = path.join(OUTPUT_DIR, `${table}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`  exported ${table}: ${rows.length} rows → ${file}`);
}

async function run() {
    const arg    = process.argv[2];
    const tables = arg ? arg.split(',') : MANIFEST.tables;

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`\nExporting to ${OUTPUT_DIR}...\n`);

    for (const table of tables) {
        try {
            await exportTable(table.trim());
        } catch (e) {
            console.error(`  FAILED ${table}: ${e.message}`);
        }
    }

    console.log('\nDone.\n');
    process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
