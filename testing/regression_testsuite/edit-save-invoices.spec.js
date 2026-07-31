// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiPost, apiPatch, apiDelete, testTag, testSlug } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

// No PUT route exists for invoices (only POST create + PATCH status) — this covers
// add-save and the status-transition path, not an "edit", matching the actual API surface.
// Logged in as site_admin (not admin): /api/tenants/mine scopes 'admin' role to tenants
// assigned via group membership, which the seeded admin user has none of — site_admin
// sees all tenants and still satisfies invoices.js's requireAdmin guard.

let tenantId    = null;
let createdId   = null;

test.describe('Invoices — add/save + status-transition coverage', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        const tenant = await apiPost(page, '/api/tenants', { name: testTag('InvoiceTenant'), slug: testSlug('tenant') });
        tenantId = tenant.id;
        await page.goto('/invoices');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        // Neither invoices nor tenants have a DELETE route — apiDelete no-ops safely
        // (see helpers/edit-save.js). Acceptable here: the regression DB is truncated
        // once at suite start (global-setup.js), and no other test in this file
        // depends on the tenant/invoice being absent mid-suite.
        tenantId = null;
        createdId = null;
    });

    test('creating an invoice with a line item persists via API readback', async ({ page }) => {
        await page.click('button:has-text("+ New Invoice")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#ld-0', testTag('line-item'));
        await page.fill('#lq-0', '2');
        await page.fill('#lp-0', '150');
        await page.click('button:has-text("Create Invoice")');

        await expect(page.locator('#f-tenant')).not.toBeVisible({ timeout: 8_000 });

        const invoices = await apiGet(page, '/api/invoices');
        // Loose equality: NonDB mode stores tenant_id as the raw DOM-select string value
        // ("5"), not a number — same reason FileDbService.find() uses `==` internally.
        const created  = invoices.find(i => i.tenant_id == tenantId);
        expect(created, 'expected the created invoice to be readable via the API').toBeTruthy();
        expect(Number(created.subtotal)).toBe(300); // 2 * 150
        createdId = created.id;
    });

    test('Send transitions status draft -> sent, persisted via API readback', async ({ page }) => {
        await page.click('button:has-text("+ New Invoice")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#ld-0', testTag('line-item'));
        await page.click('button:has-text("Create Invoice")');
        await expect(page.locator('#f-tenant')).not.toBeVisible({ timeout: 8_000 });

        let invoices = await apiGet(page, '/api/invoices');
        let created  = invoices.find(i => i.tenant_id == tenantId); // loose equality — see note above
        createdId    = created.id;
        expect(created.status).toBe('draft');

        await page.locator(`tr:has-text("${created.invoice_number}") button:has-text("Send")`).click();
        await page.waitForTimeout(500);

        invoices = await apiGet(page, '/api/invoices');
        expect(invoices.find(i => i.id === createdId).status).toBe('sent');
    });

    test('Mark Paid transitions status sent -> paid, persisted via API readback', async ({ page }) => {
        await page.click('button:has-text("+ New Invoice")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));
        await page.fill('#ld-0', testTag('line-item'));
        await page.click('button:has-text("Create Invoice")');
        await expect(page.locator('#f-tenant')).not.toBeVisible({ timeout: 8_000 });

        let invoices = await apiGet(page, '/api/invoices');
        let created  = invoices.find(i => i.tenant_id == tenantId);
        createdId    = created.id;

        // Send first — "Mark Paid" only renders for status=sent invoices.
        await page.locator(`tr:has-text("${created.invoice_number}") button:has-text("Send")`).click();
        await page.waitForTimeout(500);

        await page.locator(`tr:has-text("${created.invoice_number}") button:has-text("Mark Paid")`).click();
        await page.waitForTimeout(500);

        invoices = await apiGet(page, '/api/invoices');
        expect(invoices.find(i => i.id === createdId).status).toBe('paid');
    });

    test('creating an invoice with multiple line items sums the subtotal correctly', async ({ page }) => {
        await page.click('button:has-text("+ New Invoice")');
        await page.waitForSelector('#f-tenant');
        await page.selectOption('#f-tenant', String(tenantId));

        await page.fill('#ld-0', testTag('line-1'));
        await page.fill('#lq-0', '2');
        await page.fill('#lp-0', '100');

        await page.click('button:has-text("+ Add Line")');
        await page.fill('#ld-1', testTag('line-2'));
        await page.fill('#lq-1', '3');
        await page.fill('#lp-1', '50');

        await page.click('button:has-text("+ Add Line")');
        await page.fill('#ld-2', testTag('line-3'));
        await page.fill('#lq-2', '1');
        await page.fill('#lp-2', '25');

        await page.click('button:has-text("Create Invoice")');
        await expect(page.locator('#f-tenant')).not.toBeVisible({ timeout: 8_000 });

        const invoices = await apiGet(page, '/api/invoices');
        const created  = invoices.find(i => i.tenant_id == tenantId);
        expect(created, 'expected the created invoice to be readable via the API').toBeTruthy();
        // (2*100) + (3*50) + (1*25) = 200 + 150 + 25 = 375
        expect(Number(created.subtotal)).toBe(375);
        createdId = created.id;
    });

    // ── filter/read coverage ──────────────────────────────────────────────────
    test.describe('filters', () => {
        let draftId  = null;
        let sentId   = null;
        let draftNum;
        let sentNum;

        test.beforeEach(async ({ page }) => {
            const today = new Date().toISOString().slice(0, 10);
            const due   = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);

            const draftInv = await apiPost(page, '/api/invoices', { tenant_id: tenantId, issue_date: today, due_date: due, line_items: [] });
            draftId = draftInv.id;
            draftNum = draftInv.invoice_number;

            const sentInv = await apiPost(page, '/api/invoices', { tenant_id: tenantId, issue_date: today, due_date: due, line_items: [] });
            sentId = sentInv.id;
            sentNum = sentInv.invoice_number;
            await apiPatch(page, `/api/invoices/${sentId}/status`, { status: 'sent' });

            await page.goto('/invoices');
            await page.waitForSelector('.amrd-table', { timeout: 10_000 });
        });

        test.afterEach(() => { draftId = sentId = null; });

        test('"draft" status filter shows the draft invoice and hides the sent one', async ({ page }) => {
            await page.click('button:has-text("draft")');
            await expect(page.locator(`td:has-text("${draftNum}")`)).toBeVisible();
            await expect(page.locator(`td:has-text("${sentNum}")`)).not.toBeVisible();
        });

        test('"sent" status filter shows the sent invoice and hides the draft one', async ({ page }) => {
            await page.click('button:has-text("sent")');
            await expect(page.locator(`td:has-text("${sentNum}")`)).toBeVisible();
            await expect(page.locator(`td:has-text("${draftNum}")`)).not.toBeVisible();
        });

        test('"All" filter shows both again', async ({ page }) => {
            await page.click('button:has-text("draft")');
            await expect(page.locator(`td:has-text("${sentNum}")`)).not.toBeVisible();
            await page.click('button:has-text("All")');
            await expect(page.locator(`td:has-text("${draftNum}")`)).toBeVisible();
            await expect(page.locator(`td:has-text("${sentNum}")`)).toBeVisible();
        });
    });
});
