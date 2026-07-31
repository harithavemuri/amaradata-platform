// @ts-check
/**
 * Tenants page — empty state. Numeric-prefixed filename is deliberate: these
 * assertions require the tenants table to be genuinely empty, which is only
 * true immediately after global-setup.js's truncation — any other spec file
 * that creates a tenant (several do, since there's no DELETE /api/tenants
 * route) would otherwise pollute this check. Playwright runs spec files in
 * alphabetical order when workers:1 (this config), so "00-" guarantees this
 * file runs before every other *.spec.js in this directory.
 */
import { test, expect } from './helpers/perf-tracking.js';

const ADMIN = {
    email:    'playwright-admin@test.local',
    password: 'PlaywrightTest123!',
};

async function loginAdmin(page) {
    await page.goto('/login');
    await page.fill('#username', ADMIN.email);
    await page.fill('#password', ADMIN.password);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 5_000 });
}

test.describe('Tenants page — empty state', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
        await page.goto('/tenants');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test('shows "0 tenant(s)" count when no tenants exist', async ({ page }) => {
        await expect(page.locator('text=0 tenant(s)')).toBeVisible();
    });

    test('table headers are present', async ({ page }) => {
        const headers = page.locator('.amrd-table thead th');
        await expect(headers.nth(0)).toHaveText('Name');
        await expect(headers.nth(1)).toHaveText('Contact');
        await expect(headers.nth(2)).toHaveText('Phone');
        await expect(headers.nth(3)).toHaveText('Status');
        await expect(headers.nth(4)).toHaveText('Onboarded');
        await expect(headers.nth(5)).toHaveText('Site');
    });

    test('empty table shows "No tenants yet" message', async ({ page }) => {
        await expect(page.locator('td:has-text("No tenants yet")')).toBeVisible();
    });

    test('"+ Add Tenant" button is visible', async ({ page }) => {
        await expect(page.locator('button:has-text("+ Add Tenant")')).toBeVisible();
    });
});
