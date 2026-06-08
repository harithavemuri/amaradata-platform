// Runs once before all tests.
// - NonDB mode (default): resets playwright-testdata/ JSON files, seeds admin user.
// - DB mode (REGRESSION_DB=1): truncates _test database tables, seeds admin user.
const { mkdirSync, writeFileSync } = require('fs');
const { resolve }                  = require('path');
const { Client }                   = require('pg');

const DB_MODE       = process.env.REGRESSION_DB === '1';
const TEST_DATA_DIR = resolve(__dirname, '..', 'playwright-testdata');
const BASE_URL      = 'http://localhost:9001';
const SETUP_KEY     = 'playwright-test-secret-32chars!!';

const TABLES = [
    'amr_password_reset_tokens', 'amr_user_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_user_groups',
    'amr_users', 'amr_roles',
];

const ADMIN_USER = {
    email:    'playwright-admin@test.local',
    password: 'PlaywrightTest123!',
    name:     'Playwright Admin',
    role:     'admin',
};

module.exports = async function globalSetup() {
    if (DB_MODE) {
        const dbName = process.env.TEST_DB_NAME || 'amaradata-platform_test';
        if (!dbName.endsWith('_test')) {
            throw new Error(
                `REFUSED: regression tests will not run against "${dbName}". ` +
                `Database name must end with _test.`
            );
        }

        console.log(`[setup] DB mode — truncating ${dbName}...`);
        const client = new Client({
            host:     process.env.TEST_DB_HOST     || 'localhost',
            port:     parseInt(process.env.TEST_DB_PORT || '5435'),
            database: dbName,
            user:     process.env.TEST_DB_USER     || 'postgres',
            password: process.env.TEST_DB_PASSWORD || 'AccuSync892',
        });
        await client.connect();
        try {
            await client.query(
                `TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
            );
        } finally {
            await client.end();
        }
        console.log('[setup] Tables truncated.');
    } else {
        // NonDB mode — reset JSON files
        mkdirSync(TEST_DATA_DIR, { recursive: true });
        for (const table of TABLES) {
            writeFileSync(resolve(TEST_DATA_DIR, `${table}.json`), '[]');
        }
    }

    // Seed admin user via API (both modes)
    const res = await fetch(`${BASE_URL}/api/auth/create-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...ADMIN_USER, setup_key: SETUP_KEY }),
    });

    if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Failed to seed admin user: HTTP ${res.status} — ${body.error || 'unknown'}`);
    }

    console.log(`[setup] Admin user ready: ${ADMIN_USER.email}`);
};
