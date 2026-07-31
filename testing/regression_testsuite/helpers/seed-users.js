// Shared seeded-user credentials for testing/regression_testsuite specs — one
// per role, so every role has E2E login coverage (see role-login-smoke.spec.js).
// global-setup.js seeds all of these via POST /api/auth/create-user.
//
// login-dashboard.spec.js and tenants.spec.js predate this file and keep their
// own inline 'admin' constant (identical values) rather than being rewired —
// not worth touching already-passing specs for a pure duplication cleanup.
const SETUP_KEY = 'playwright-test-secret-32chars!!';

const SEED_USERS = {
    admin:         { email: 'playwright-admin@test.local',        password: 'PlaywrightTest123!', name: 'Playwright Admin',         role: 'admin' },
    site_admin:    { email: 'playwright-siteadmin@test.local',    password: 'PlaywrightTest123!', name: 'Playwright Site Admin',    role: 'site_admin' },
    sales_manager: { email: 'playwright-salesmanager@test.local', password: 'PlaywrightTest123!', name: 'Playwright Sales Manager', role: 'sales_manager' },
    billing:       { email: 'playwright-billing@test.local',      password: 'PlaywrightTest123!', name: 'Playwright Billing',       role: 'billing' },
    staff:         { email: 'playwright-staff@test.local',        password: 'PlaywrightTest123!', name: 'Playwright Staff',         role: 'staff' },
};

module.exports = { SEED_USERS, SETUP_KEY };
