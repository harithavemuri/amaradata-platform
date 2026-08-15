// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { SEED_USERS } from './helpers/seed-users.js';

// 'admin' role's login/dashboard/nav coverage already lives in login-dashboard.spec.js
// (see its "Dashboard — sidebar fully rendered (admin role)" describe block) — this file
// covers the other 4 roles so responsibility isn't duplicated across two spec files.
//
// amaradata has only 5 roles (vs. rohas-group's 21), and today only 'staff' and
// 'site_admin' render a different nav from the baseline — 'sales_manager' and 'billing'
// currently look identical to 'admin' in the UI, so their checks are necessarily thinner
// (login + dashboard render only). That's a real gap in the frontend's role
// differentiation, not a gap in this test's coverage — flagging here rather than
// silently expanding scope into a frontend change.
const ROLES_TO_CHECK = ['site_admin', 'sales_manager', 'billing', 'staff'];

async function login(page, user) {
    await page.goto('/login');
    await page.fill('#username', user.email);
    await page.fill('#password', user.password);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 10_000 });
}

for (const role of ROLES_TO_CHECK) {
    const user = SEED_USERS[role];

    test.describe(`Role login smoke — ${role}`, () => {
        test(`${role} can log in and lands on /dashboard with the correct role shown`, async ({ page }) => {
            await login(page, user);
            expect(page.url()).toContain('/dashboard');
            await expect(page.locator('.amrd-user-role')).toHaveText(role);
            await expect(page.locator('.amrd-user-name')).toHaveText(user.name);
        });
    });
}

test.describe('Role login smoke — site_admin nav differences', () => {
    test('site_admin sees User Management section', async ({ page }) => {
        await login(page, SEED_USERS.site_admin);
        await expect(page.locator('text=User Management')).toBeVisible();
    });

});

test.describe('Role login smoke — staff nav differences', () => {
    test('staff does NOT see the Email nav link', async ({ page }) => {
        await login(page, SEED_USERS.staff);
        await expect(page.locator('.amrd-nav a[href="/email"]')).not.toBeVisible();
    });

    test('staff does NOT see User Management section', async ({ page }) => {
        await login(page, SEED_USERS.staff);
        await expect(page.locator('text=User Management')).not.toBeVisible();
    });
});

test.describe('Role login smoke — sales_manager / billing nav parity with admin', () => {
    test('sales_manager sees the Email nav link (unlike staff)', async ({ page }) => {
        await login(page, SEED_USERS.sales_manager);
        await expect(page.locator('.amrd-nav a[href="/email"]')).toBeVisible();
    });

    test('billing sees the Email nav link (unlike staff)', async ({ page }) => {
        await login(page, SEED_USERS.billing);
        await expect(page.locator('.amrd-nav a[href="/email"]')).toBeVisible();
    });
});
