// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { apiGet, testTag } from './helpers/edit-save.js';

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

// No DELETE route exists for /api/tenants (confirmed: only GET/POST/PUT) — tenants
// created by these tests accumulate for the rest of the suite run. Acceptable: the
// regression DB is truncated once at suite start (global-setup.js), and this file's
// own tests only ever look up tenants by their own unique generated name/slug.

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

// "Empty state" checks moved to 00-tenants-empty-state.spec.js — see that file's
// header comment for why (they need the tenants table to be genuinely empty,
// which only holds true if that file runs first).

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

        // API readback — catches DB-mode routing bugs a DOM-only check would miss.
        const tenants = await apiGet(page, '/api/tenants');
        const created = tenants.find(t => t.slug === 'acme-corp');
        expect(created, 'expected the created tenant to be readable via the API').toBeTruthy();
        expect(created.name).toBe('Acme Corp');
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

        // Unique per-run (and per-process — the load test runs 5 concurrent
        // OS processes that could otherwise collide within the same millisecond)
        const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

        // API readback — proves the edit actually persisted, not just a stale/optimistic DOM update.
        const tenants = await apiGet(page, '/api/tenants');
        const updated = tenants.find(t => t.slug === tenantSlug);
        expect(updated, 'expected the edited tenant to still be readable via the API').toBeTruthy();
        expect(updated.name).toBe(`${tenantName} Updated`);
    });

    test('changing status to "suspended" shows suspended badge', async ({ page }) => {
        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await page.selectOption('#f-status', 'suspended');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator('.amrd-badge-suspended')).toBeVisible();
    });

    test('editing contact/billing/tax/site fields persists via API readback', async ({ page }) => {
        const contactName  = testTag('Contact');
        const contactEmail = `zzzzzz-contact-${Date.now()}@test.local`;
        const phone        = '+1-555-0100';
        const address      = testTag('123 Billing St');
        const gstin        = 'ZZZZZ1234Z1Z5';
        const pan          = 'ZZZZZ1234Z';
        const siteUrl      = 'https://zzzzzz-example.test';

        await page.locator(`tr:has-text("${tenantName}") button:has-text("Edit")`).first().click();
        await page.waitForSelector('#f-cname');
        await page.fill('#f-cname', contactName);
        await page.fill('#f-cemail', contactEmail);
        await page.fill('#f-phone', phone);
        await page.fill('#f-addr', address);
        await page.fill('#f-gstin', gstin);
        await page.fill('#f-pan', pan);
        await page.fill('#f-siteurl', siteUrl);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#f-name')).not.toBeVisible({ timeout: 8_000 });

        const tenants = await apiGet(page, '/api/tenants');
        const updated = tenants.find(t => t.slug === tenantSlug);
        expect(updated, 'expected the edited tenant to still be readable via the API').toBeTruthy();
        expect(updated.contact_name).toBe(contactName);
        expect(updated.contact_email).toBe(contactEmail);
        expect(updated.contact_phone).toBe(phone);
        expect(updated.billing_address).toBe(address);
        expect(updated.gstin).toBe(gstin);
        expect(updated.pan).toBe(pan);
        expect(updated.site_url).toBe(siteUrl);
    });
});
