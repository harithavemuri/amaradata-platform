// Runs after webServer starts, before any test file executes.
// Creates the isolated test-data directory and seeds the admin test user.
const { mkdirSync, writeFileSync } = require('fs');
const { resolve }                  = require('path');

const TEST_DATA_DIR = resolve(__dirname, '..', 'playwright-testdata');
const TABLES = [
    'amr_users', 'amr_roles', 'amr_user_groups', 'amr_user_group_members',
    'tenants', 'subscription_plans', 'tenant_subscriptions', 'billing_metrics',
    'invoices', 'invoice_line_items', 'enhancements', 'payments',
    'contact_submissions', 'amr_password_reset_tokens',
];

const BASE_URL  = 'http://localhost:9001';
const SETUP_KEY = 'playwright-test-secret-32chars!!';

const ADMIN_USER = {
    email:    'playwright-admin@test.local',
    password: 'PlaywrightTest123!',
    name:     'Playwright Admin',
    role:     'admin',
};

module.exports = async function globalSetup() {
    // Reset all test-data tables to empty arrays
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    for (const table of TABLES) {
        writeFileSync(resolve(TEST_DATA_DIR, `${table}.json`), '[]');
    }

    // Create the admin test user via the first-time setup endpoint
    const res = await fetch(`${BASE_URL}/api/auth/create-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
            email:     ADMIN_USER.email,
            password:  ADMIN_USER.password,
            name:      ADMIN_USER.name,
            role:      ADMIN_USER.role,
            setup_key: SETUP_KEY,
        }),
    });

    if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Failed to seed admin test user: HTTP ${res.status} — ${body.error || 'unknown error'}`);
    }

    console.log(`[playwright:setup] Admin test user ready: ${ADMIN_USER.email}`);
};
