// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiPost, testTag, testSlug } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

// billing_metrics has no DELETE route and its own upsert key is (tenant_id, period_year,
// period_month) — submitting the manual-entry form twice for the same tenant+period IS
// the "edit" path (backend/routes/metrics.js:19, ON CONFLICT ... DO UPDATE). Cleanup relies
// on suite-level DB truncation (global-setup.js), same as invoices — no per-test DELETE exists.

let tenantId = null;

test.describe('Billing Metrics — upsert-style edit/save coverage', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('MetricsTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;
        await page.goto('/metrics');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(() => { tenantId = null; });

    test('submitting a metric creates a row, and re-submitting the same period updates it (upsert)', async ({ page }) => {
        const year  = 2031; // far-future year, unlikely to collide with real data
        const month = 6;

        await page.click('button:has-text("+ Manual Entry")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#f-year2', String(year));
        await page.fill('#f-month2', String(month));
        await page.fill('#f-sc', '10');
        await page.fill('#f-sv', '5000');
        await page.click('button:has-text("Save")');
        await page.waitForTimeout(500);

        let metrics = await apiGet(page, `/api/metrics`);
        // Loose equality on tenant_id: NonDB mode stores it as the raw DOM-select string value.
        let created = metrics.find(m => m.tenant_id == tenantId && m.period_year === year && m.period_month === month);
        expect(created, 'expected the created metric to be readable via the API').toBeTruthy();
        expect(Number(created.sales_count)).toBe(10);
        expect(Number(created.sales_value)).toBe(5000);

        // Re-submit for the SAME tenant+period with a changed value — this is the "edit".
        await page.click('button:has-text("+ Manual Entry")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#f-year2', String(year));
        await page.fill('#f-month2', String(month));
        await page.fill('#f-sc', '25');
        await page.fill('#f-sv', '9999');
        await page.click('button:has-text("Save")');
        await page.waitForTimeout(500);

        metrics = await apiGet(page, `/api/metrics`);
        const updated = metrics.filter(m => m.tenant_id == tenantId && m.period_year === year && m.period_month === month);
        expect(updated, 'expected the upsert to update the existing row, not create a second one').toHaveLength(1);
        expect(Number(updated[0].sales_count)).toBe(25);
        expect(Number(updated[0].sales_value)).toBe(9999);
    });
});

// ── search/export coverage ──────────────────────────────────────────────────
test.describe('Billing Metrics — search + export', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('MetricsSearchTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;
        await page.goto('/metrics');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(() => { tenantId = null; });

    test('Year/Month search scopes to a period with a manually-entered metric', async ({ page }) => {
        const year  = 2032;
        const month = 3;

        await page.click('button:has-text("+ Manual Entry")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#f-year2', String(year));
        await page.fill('#f-month2', String(month));
        await page.fill('#f-sc', '7');
        await page.click('button:has-text("Save")');
        await page.waitForTimeout(500);

        await page.fill('#sf-year', String(year));
        await page.fill('#sf-month', String(month));
        await page.selectOption('#sf-tenant', String(tenantId));
        await page.click('#btn-search');

        await expect(page.locator('#metrics-tbody')).not.toContainText('No data for this period');
    });

    test('resetting the search restores the current-period view', async ({ page }) => {
        await page.fill('#sf-year', '2032');
        await page.selectOption('#sf-tenant', String(tenantId));
        await page.click('#btn-search');
        await page.click('#btn-reset');

        await expect(page.locator('#sf-year')).toHaveValue(String(new Date().getFullYear()));
        await expect(page.locator('#sf-tenant')).toHaveValue('');
    });

    test('CSV export button triggers a download', async ({ page }) => {
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.click('#btn-export'),
        ]);
        expect(download.suggestedFilename()).toBe('billing-metrics.csv');
    });
});
