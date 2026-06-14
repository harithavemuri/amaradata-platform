import fs   from 'fs';
import path from 'path';

const NONDB_TEST_DIR = path.join(process.cwd(), '.tmp-nondb-testdata');

const TABLES = [
    'amr_password_reset_tokens', 'group_tenant', 'amr_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_groups',
    'amr_users', 'amr_roles',
];

export default async function setup() {
    fs.mkdirSync(NONDB_TEST_DIR, { recursive: true });
    for (const t of TABLES) {
        fs.writeFileSync(path.join(NONDB_TEST_DIR, `${t}.json`), '[]');
    }
    // Inherited by all worker threads
    process.env.NONDB_MODE          = 'true';
    process.env.TRANSACTIONDATA_DIR = NONDB_TEST_DIR;
}

export async function teardown() {
    try { fs.rmSync(NONDB_TEST_DIR, { recursive: true, force: true }); } catch {}
}
