import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DATA_DIR = resolve('testing/testdata');
const TABLES = [
    'amr_users', 'amr_roles', 'amr_user_groups', 'amr_user_group_members',
    'tenants', 'subscription_plans', 'tenant_subscriptions', 'billing_metrics',
    'invoices', 'invoice_line_items', 'enhancements', 'payments',
    'contact_submissions', 'amr_password_reset_tokens',
];

export default function setup() {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    for (const table of TABLES) {
        writeFileSync(resolve(TEST_DATA_DIR, `${table}.json`), '[]');
    }
}
