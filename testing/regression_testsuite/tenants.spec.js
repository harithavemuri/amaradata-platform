// @ts-check
import { test, expect } from '@playwright/test';

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

// ── Page basics ───────────────────────────────────────────────────────────────
test.describe('Tenants page — basics', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
        await page.goto('/tenants');
        await page.waitForURL('**/tenants', { timeout: 5_000 });
    });

    test('page title is "Tenants — AmaraData Platform"', async ({ page }) => {
        await expect(page).toHaveTitle('Tenants — AmaraData Platform');
    });

    test('URL is /tenants', async ({ page }) => {
        expect(page.url()).toContain('/tenants');
    });

    test('topbar shows "Tenants" as page title', async ({ page }) => {
        await expect(page.locator('.amrd-topbar-title')).toHaveText('Tenants');
    });

    test('Tenants nav link has "active" class', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/tenants"]')).toHaveClass(/active/);
    });

    test('sidebar is visible', async ({ page }) => {
        await expect(page.locator('.amrd-sidebar')).toBeVisible();
    });
});

// ── Empty state ───────────────────────────────────────────────────────────────
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

// ── Add Tenant form ───────────────────────────────────────────────────────────
test.describe('Tenants page — Add Tenant form', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
        await page.goto('/tenants');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name', { timeout: 5_000 });
    });

    test('form heading says "New Tenant"', async ({ page }) => {
        await expect(page.locator('h3:has-text("New Tenant")')).toBeVisible();
    });

    test('all form fields are present', async ({ page }) => {
        await expect(page.locator('#f-name')).toBeVisible();
        await expect(page.locator('#f-slug')).toBeVisible();
        await expect(page.locator('#f-cname')).toBeVisible();
        await expect(page.locator('#f-cemail')).toBeVisible();
        await expect(page.locator('#f-phone')).toBeVisible();
        await expect(page.locator('#f-status')).toBeVisible();
        await expect(page.locator('#f-gstin')).toBeVisible();
        await expect(page.locator('#f-pan')).toBeVisible();
        await expect(page.locator('#f-onboard')).toBeVisible();
        await expect(page.locator('#f-siteurl')).toBeVisible();
        await expect(page.locator('#f-addr')).toBeVisible();
    });

    test('status dropdown has active, suspended, churned options', async ({ page }) => {
        const options = page.locator('#f-status option');
        await expect(options).toHaveCount(3);
        await expect(options.nth(0)).toHaveText('active');
        await expect(options.nth(1)).toHaveText('suspended');
        await expect(options.nth(2)).toHaveText('churned');
    });

    test('Save and Cancel buttons are present', async ({ page }) => {
        await expect(page.locator('button:has-text("Save")')).toBeVisible();
        await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
    });

    test('Cancel closes the form', async ({ page }) => {
        await page.click('button:has-text("Cancel")');
        await expect(page.locator('#f-name')).not.toBeVisible();
        await expect(page.locator('h3:has-text("New Tenant")')).not.toBeVisible();
    });

    test('saving without name and slug shows error', async ({ page }) => {
        await page.click('button:has-text("Save")');
        await expect(page.locator('#save-err')).toBeVisible();
        await expect(page.locator('#save-err')).not.toHaveText('');
    });
});

// ── Create tenant ─────────────────────────────────────────────────────────────
test.describe('Tenants page — create tenant', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
        await page.goto('/tenants');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test('creating a tenant adds it to the table', async ({ page }) => {
        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name');

        await page.fill('#f-name',   'Acme Corp');
        await page.fill('#f-slug',   'acme-corp');
        await page.fill('#f-cname',  'Jane Smith');
        await page.fill('#f-cemail', 'jane@acme.com');
        await page.fill('#f-phone',  '+91-9876543210');
        await page.click('button:has-text("Save")');

        // Table reloads — form disappears and row appears
        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator('td:has-text("Acme Corp")')).toBeVisible();
    });

    test('tenant count increments after creating a tenant', async ({ page }) => {
        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name');

        await page.fill('#f-name', 'Beta Ltd');
        await page.fill('#f-slug', 'beta-ltd');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        // At least 1 tenant now (may be more if other tests ran first in same suite)
        await expect(page.locator('text=/\\d+ tenant\\(s\\)/')).toBeVisible();
        await expect(page.locator('td:has-text("No tenants yet")')).not.toBeVisible();
    });

    test('new tenant shows "active" status badge by default', async ({ page }) => {
        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name');

        await page.fill('#f-name', 'Gamma Inc');
        await page.fill('#f-slug', 'gamma-inc');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator('.amrd-badge-active').last()).toBeVisible();
    });

    test('new tenant shows slug in table', async ({ page }) => {
        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name');

        await page.fill('#f-name', 'Delta Co');
        await page.fill('#f-slug', 'delta-co');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator('text=delta-co')).toBeVisible();
    });
});

// ── Edit tenant ───────────────────────────────────────────────────────────────
test.describe('Tenants page — edit tenant', () => {
    let tenantName;
    let tenantSlug;

    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
        await page.goto('/tenants');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });

        // Unique per-run to avoid slug collisions in the real DB
        const uid = Date.now().toString(36);
        tenantName = `Edit Me Corp ${uid}`;
        tenantSlug = `edit-me-${uid}`;

        await page.click('button:has-text("+ Add Tenant")');
        await page.waitForSelector('#f-name');
        await page.fill('#f-name', tenantName);
        await page.fill('#f-slug', tenantSlug);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator(`td:has-text("${tenantName}")`).first()).toBeVisible();
    });

    test('Edit button opens form with heading "Edit Tenant"', async ({ page }) => {
        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await expect(page.locator('h3:has-text("Edit Tenant")')).toBeVisible();
    });

    test('Edit form is pre-filled with tenant name and slug', async ({ page }) => {
        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await expect(page.locator('#f-name')).toHaveValue(tenantName);
        await expect(page.locator('#f-slug')).toHaveValue(tenantSlug);
    });

    test('editing name and saving updates the table row', async ({ page }) => {
        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await page.fill('#f-name', `${tenantName} Updated`);
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator(`td:has-text("${tenantName} Updated")`)).toBeVisible();
    });

    test('changing status to "suspended" shows suspended badge', async ({ page }) => {
        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await page.selectOption('#f-status', 'suspended');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator('.amrd-badge-suspended')).toBeVisible();
    });
});
