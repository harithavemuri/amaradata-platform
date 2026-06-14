import pg from 'pg';
import { testDb } from './test-db-config.js';

const { Pool } = pg;

const TABLES = [
    'amr_password_reset_tokens', 'group_tenant', 'amr_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_groups',
    'amr_users', 'amr_roles',
];

function assertTestDb() {
    if (!testDb.database.endsWith('_test')) {
        throw new Error(
            `REFUSED: test suite will not run against "${testDb.database}". ` +
            `Database name must end with _test.`
        );
    }
}

export default async function setup() {
    assertTestDb();

    const pool = new Pool(testDb);
    try {
        await pool.query(
            `TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
        );

        // Seed the 5 system roles so role-related queries work
        await pool.query(`
            INSERT INTO amr_roles (name, label, description, is_system) VALUES
            ('site_admin',    'Site Admin',    'Full platform access',          true),
            ('admin',         'Admin',         'Tenant admin access',           true),
            ('sales_manager', 'Sales Manager', 'Sales and CRM access',          true),
            ('billing',       'Billing',       'Billing and invoicing access',  true),
            ('staff',         'Staff',         'Basic read-only access',        true)
            ON CONFLICT (name) DO NOTHING
        `);

        // Seed test users matching the JWT helper IDs (901=admin, 902=site_admin, 903=staff)
        // These IDs are used by auth tokens in helpers.js — invoices.created_by FKs amr_users.id
        await pool.query(`
            INSERT INTO amr_users (id, username, email, name, role, password_hash) VALUES
            (901, 'test.admin',     'admin@t.com',  'Admin',     'admin',      ''),
            (902, 'test.siteadmin', 'sadmin@t.com', 'SiteAdmin', 'site_admin', ''),
            (903, 'test.staff',     'staff@t.com',  'Staff',     'staff',      '')
            ON CONFLICT (id) DO NOTHING
        `);
    } finally {
        await pool.end();
    }
}

export async function teardown() {
    assertTestDb();
}
