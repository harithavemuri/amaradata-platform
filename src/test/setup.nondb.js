import fs   from 'fs';
import path from 'path';

// Re-assert NonDB mode in each worker (globalSetup env is inherited, but be explicit)
process.env.NONDB_MODE = 'true';

process.env.AMRD_JWT_SECRET      = 'test-jwt-secret-32-chars-minimum!!';
process.env.SSO_SECRET           = 'test-sso-secret-32-chars-minimum!!';
process.env.ROHAS_URL            = 'http://localhost:8002';
process.env.GOOGLE_CLIENT_ID     = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI  = 'http://localhost/callback';
process.env.FRONTEND_URL         = 'http://localhost';

// Wipe all table files before each test file so every suite starts with a clean slate
const TABLES = [
    'amr_password_reset_tokens', 'group_tenant', 'amr_group_members',
    'contact_submissions', 'payments', 'invoice_line_items', 'billing_metrics',
    'tenant_subscriptions', 'invoices', 'enhancements',
    'tenants', 'subscription_plans', 'amr_groups',
    'amr_users', 'amr_roles',
];

const dir = process.env.TRANSACTIONDATA_DIR;
if (dir) {
    for (const t of TABLES) {
        fs.writeFileSync(path.join(dir, `${t}.json`), '[]');
    }
}
