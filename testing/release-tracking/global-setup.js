// Runs once before release-tracking checks (local mode only — skipped when
// PW_BASE_URL points at a real deployed environment).
// Truncates the shared _test DB's tables, seeds one tenant (so CSV Tenant Name
// matching has something to resolve against) and an admin user.
//
// Was NonDB/JSON-file-based until NonDB mode became read-only — see
// project-nondb-read-only.md and server-entry.js's header comment.
const { Pool } = require('pg');
const { testDb } = require('../../src/test/test-db-config.js');

const BASE_URL  = 'http://localhost:9002';
const SETUP_KEY = 'release-checks-test-secret-32ch!!';

const TABLES = [
    'amr_password_reset_tokens', 'amr_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_groups',
    'amr_users', 'amr_roles', 'login_audit',
];

const ADMIN_USER = {
    email:    'release-checks-admin@test.local',
    password: 'ReleaseChecks123!',
    name:     'Release Checks Admin',
    role:     'admin',
};

module.exports = async function globalSetup() {
    if (!testDb.database.endsWith('_test')) {
        throw new Error(
            `REFUSED: release-tracking checks will not run against "${testDb.database}". ` +
            `Database name must end with _test.`
        );
    }

    const pool = new Pool(testDb);
    try {
        await pool.query(
            `TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
        );
        await pool.query(`
            INSERT INTO tenants (id, name, slug, status, currency_code)
            VALUES (1, 'Rohas Group', 'rohas', 'active', 'INR')
        `);
        // login_audit references amr_roles/amr_users FKs — seed a role so
        // create-user below (which resolves an effective role via group_tenant
        // joins) has something valid to fall back to.
        await pool.query(`
            INSERT INTO amr_roles (name, label, description, is_system) VALUES
            ('super_admin', 'Super Admin', 'Full platform access', true),
            ('admin',      'Admin',      'Tenant admin access',  true)
            ON CONFLICT (name) DO NOTHING
        `);
    } finally {
        await pool.end();
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

    console.log(`[release-tracking setup] Tenant "Rohas Group" + admin user ready.`);
};
