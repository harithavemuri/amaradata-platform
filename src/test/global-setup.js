import pg from 'pg';
import { testDb } from './test-db-config.js';

const { Pool } = pg;

const TABLES = [
    'amr_password_reset_tokens', 'amr_user_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_user_groups',
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
    } finally {
        await pool.end();
    }
}

export async function teardown() {
    assertTestDb();
}
