// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiPost, apiDelete, testTag, testSlug } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

let createdId = null;

test.describe('Enhancements — edit/save coverage', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.admin);
        await page.goto('/enhancements');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        if (createdId) { await apiDelete(page, `/api/enhancements/${createdId}`); createdId = null; }
    });

    test('logging new work creates a record, verified via API', async ({ page }) => {
        const title = testTag('enhancement');

        await page.click('button:has-text("+ Log Work")');
        await page.waitForSelector('#f-title');

        // Tenant select — pick whatever first option exists (seeded by an earlier test or none)
        const tenantOptions = await page.locator('#f-tenant option').count();
        if (tenantOptions > 1) await page.selectOption('#f-tenant', { index: 1 });

        await page.fill('#f-title', title);
        await page.fill('#f-desc', 'Created by edit-save-enhancements.spec.js');
        await page.click('button:has-text("Save")');

        if (tenantOptions <= 1) {
            // No tenant exists yet — Save should fail client-side with a required-field error, not silently succeed.
            await expect(page.locator('#save-err')).not.toHaveText('');
            return;
        }

        await expect(page.locator('#f-title')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator(`td:has-text("${title}")`)).toBeVisible();

        const rows = await apiGet(page, '/api/enhancements');
        const created = rows.find(r => r.title === title);
        expect(created, 'expected the created enhancement to be readable via the API').toBeTruthy();
        createdId = created.id;
    });

    test('editing an existing enhancement persists via API readback', async ({ page }) => {
        const tenantOptions = await page.locator('#f-tenant option').count();
        test.skip(tenantOptions <= 1, 'no tenant available to attach an enhancement to');

        const title    = testTag('edit-me');
        const newTitle = `${title} updated`;

        await page.click('button:has-text("+ Log Work")');
        await page.waitForSelector('#f-title');
        await page.selectOption('#f-tenant', { index: 1 });
        await page.fill('#f-title', title);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#f-title')).not.toBeVisible({ timeout: 8_000 });

        let rows = await apiGet(page, '/api/enhancements');
        let created = rows.find(r => r.title === title);
        createdId = created.id;

        await page.locator(`tr:has-text("${title}") button:has-text("Edit")`).first().click();
        await page.fill('#f-title', newTitle);
        await page.selectOption('#f-status', 'delivered');
        await page.click('button:has-text("Save")');
        await expect(page.locator('#f-title')).not.toBeVisible({ timeout: 8_000 });

        rows = await apiGet(page, '/api/enhancements');
        const updated = rows.find(r => r.id === createdId);
        expect(updated.title).toBe(newTitle);
        expect(updated.status).toBe('delivered');
    });
});

// ── filter/read coverage ──────────────────────────────────────────────────────
// Deliberately a separate top-level describe, not nested inside the one above:
// nesting would run both describes' beforeEach hooks against the SAME page for
// one test — the outer one logs in as 'admin' first, then this one's loginAs()
// tries to log in again as site_admin on that already-authenticated page.
// login.html auto-redirects to /dashboard whenever already logged in, so
// #username never renders for the second login attempt (reproduced: all 3
// tests here timed out on page.fill('#username', ...) until this was split out).
//
// Logged in as site_admin (not admin): /api/tenants/mine scopes 'admin' to
// tenants assigned via group membership, which this test can't easily set up
// just to create a scratch tenant — site_admin sees all tenants and still
// satisfies enhancements.js's requireAdmin guard.
test.describe('Enhancements — filters', () => {
    let tenantId = null;
    let bugId    = null;
    let enhId    = null;
    let bugTitle;
    let enhTitle;

    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('FilterTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;

        bugTitle = testTag('filter-bug');
        enhTitle = testTag('filter-enh');
        const bug = await apiPost(page, '/api/enhancements', { tenant_id: tenantId, title: bugTitle, item_type: 'bug' });
        bugId = bug.id;
        const enh = await apiPost(page, '/api/enhancements', { tenant_id: tenantId, title: enhTitle, item_type: 'enhancement' });
        enhId = enh.id;

        await page.goto('/enhancements');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        if (bugId) await apiDelete(page, `/api/enhancements/${bugId}`);
        if (enhId) await apiDelete(page, `/api/enhancements/${enhId}`);
        bugId = enhId = tenantId = null;
    });

    test('"Bugs" type search shows the bug and hides the enhancement', async ({ page }) => {
        await page.selectOption('#sf-type', 'bug');
        await page.click('#btn-search');
        await expect(page.locator(`td:has-text("${bugTitle}")`)).toBeVisible();
        await expect(page.locator(`td:has-text("${enhTitle}")`)).not.toBeVisible();
    });

    test('"Enhancements" type search shows the enhancement and hides the bug', async ({ page }) => {
        await page.selectOption('#sf-type', 'enhancement');
        await page.click('#btn-search');
        await expect(page.locator(`td:has-text("${enhTitle}")`)).toBeVisible();
        await expect(page.locator(`td:has-text("${bugTitle}")`)).not.toBeVisible();
    });

    test('resetting the search shows both again', async ({ page }) => {
        await page.selectOption('#sf-type', 'bug');
        await page.click('#btn-search');
        await expect(page.locator(`td:has-text("${enhTitle}")`)).not.toBeVisible();
        await page.click('#btn-reset');
        await expect(page.locator(`td:has-text("${bugTitle}")`)).toBeVisible();
        await expect(page.locator(`td:has-text("${enhTitle}")`)).toBeVisible();
    });

    test('Title search filters to a matching title', async ({ page }) => {
        await page.fill('#sf-title', bugTitle);
        await page.click('#btn-search');
        await expect(page.locator(`td:has-text("${bugTitle}")`)).toBeVisible();
        await expect(page.locator(`td:has-text("${enhTitle}")`)).not.toBeVisible();
    });

    test('CSV export button triggers a download', async ({ page }) => {
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#btn-export'),
        ]);
        expect(download.suggestedFilename()).toBe('enhancements.csv');
    });
});

// ── pagination coverage ─────────────────────────────────────────────────────
// Separate top-level describe (own site_admin login + own scratch tenant), same
// reasoning as "Enhancements — filters". Creates 21 records via the API (bulk
// UI creation would be far slower) purely to exercise window.__amrd.paginate()/
// renderPagination() at the 20-per-page boundary — every other page's data
// volume is too low to ever hit page 2 in normal test runs.
test.describe('Enhancements — pagination', () => {
    test.describe.configure({ timeout: 60_000 });

    let tenantId = null;
    let createdIds = [];

    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('PagerTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;

        const tag = testTag('pager-item');
        // Parallel, not sequential — 21 awaited round-trips in series was slow
        // enough to blow the default 30s test timeout under full-suite load.
        const created = await Promise.all(
            Array.from({ length: 21 }, (_, i) =>
                apiPost(page, '/api/enhancements', { tenant_id: tenantId, title: `${tag} ${i}` }))
        );
        createdIds = created.map(item => item.id);

        await page.goto('/enhancements');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        await Promise.all(createdIds.map(id => apiDelete(page, `/api/enhancements/${id}`)));
        createdIds = [];
        tenantId = null;
    });

    test('21 results split across two pages, and Next reveals the 21st row', async ({ page }) => {
        await page.selectOption('#sf-tenant', String(tenantId));
        await page.click('#btn-search');

        await expect(page.locator('.amrd-pagination-info')).toContainText('Page 1 of 2 (21 total)');
        const rowsPage1 = await page.locator('#enh-tbody tr').count();
        expect(rowsPage1).toBe(20);

        await page.click('#amrd-pg-next');

        await expect(page.locator('.amrd-pagination-info')).toContainText('Page 2 of 2 (21 total)');
        const rowsPage2 = await page.locator('#enh-tbody tr').count();
        expect(rowsPage2).toBe(1);
    });
});

// ── full field-edit coverage ────────────────────────────────────────────────────
// Separate top-level describe (own site_admin login + own scratch tenant), same
// reasoning as "Enhancements — filters": doesn't depend on another test in this
// file having already created a tenant.
test.describe('Enhancements — full field edit', () => {
    let tenantId = null;
    let enhId    = null;

    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('FieldEditTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;
        const enh = await apiPost(page, '/api/enhancements', { tenant_id: tenantId, title: testTag('field-edit-me') });
        enhId = enh.id;

        await page.goto('/enhancements');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        if (enhId) await apiDelete(page, `/api/enhancements/${enhId}`);
        enhId = tenantId = null;
    });

    test('editing description/billing/hours/rate/delivered/notes persists via API readback', async ({ page }) => {
        const description = testTag('description');
        const notes       = testTag('notes');
        const deliveredAt = new Date().toISOString().slice(0, 10);

        const rows    = await apiGet(page, '/api/enhancements');
        const current = rows.find(r => r.id === enhId);

        await page.locator(`tr:has-text("${current.title}") button:has-text("Edit")`).first().click();
        await page.waitForSelector('#f-desc');
        await page.fill('#f-desc', description);
        await page.selectOption('#f-type', 'milestone');
        await page.fill('#f-ehours', '12.5');
        await page.fill('#f-ahours', '10');
        await page.fill('#f-rate', '75');
        await page.fill('#f-mamount', '5000');
        await page.fill('#f-deliv', deliveredAt);
        await page.fill('#f-notes', notes);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#f-desc')).not.toBeVisible({ timeout: 8_000 });

        const updated = (await apiGet(page, '/api/enhancements')).find(r => r.id === enhId);
        expect(updated.description).toBe(description);
        expect(updated.billing_type).toBe('milestone');
        expect(Number(updated.estimated_hours)).toBe(12.5);
        expect(Number(updated.actual_hours)).toBe(10);
        expect(Number(updated.hourly_rate)).toBe(75);
        expect(Number(updated.milestone_amount)).toBe(5000);
        expect(updated.delivered_at.slice(0, 10)).toBe(deliveredAt);
        expect(updated.notes).toBe(notes);
    });
});
