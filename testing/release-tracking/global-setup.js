// Runs once before release-tracking checks (NonDB/local mode only — skipped
// when PW_BASE_URL points at a real deployed environment).
// Resets testdata/ JSON files, seeds one tenant (so CSV Tenant Name matching
// has something to resolve against) and an admin user.
const { mkdirSync, writeFileSync } = require('fs');
const { resolve }                  = require('path');

const TEST_DATA_DIR = resolve(__dirname, 'testdata');
const BASE_URL      = 'http://localhost:9002';
const SETUP_KEY     = 'release-checks-test-secret-32ch!!';

const TABLES = [
    'amr_password_reset_tokens', 'amr_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_groups',
    'amr_users', 'amr_roles',
];

const TENANT = {
    id: 1, name: 'Rohas Group', slug: 'rohas', status: 'active',
    currency_code: 'INR', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

const ADMIN_USER = {
    email:    'release-checks-admin@test.local',
    password: 'ReleaseChecks123!',
    name:     'Release Checks Admin',
    role:     'admin',
};

module.exports = async function globalSetup() {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    for (const table of TABLES) {
        writeFileSync(resolve(TEST_DATA_DIR, `${table}.json`), table === 'tenants' ? JSON.stringify([TENANT]) : '[]');
    }

    const res = await fetch(`${BASE_URL}/api/auth/create-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...ADMIN_USER, setup_key: SETUP_KEY }),
    });

    if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Failed to seed admin user: HTTP ${res.status} — ${body.error || 'unknown'}`);
    }

    console.log(`[release-tracking setup] Tenant "${TENANT.name}" + admin user ready.`);
};
