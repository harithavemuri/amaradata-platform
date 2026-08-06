// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiDelete, testTag, randomRoleName } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

let createdId = null;

test.describe('Roles — edit/save coverage (site_admin only)', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        await page.goto('/roles');
        await page.waitForSelector('.amrd-table', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        if (createdId) { await apiDelete(page, `/api/admin/roles/${createdId}`); createdId = null; }
    });

    test('creating a role persists via API readback', async ({ page }) => {
        const name  = randomRoleName();
        const label = testTag('Role');

        await page.click('button:has-text("+ New Role")');
        await page.waitForSelector('#rmName');
        await page.fill('#rmName', name);
        await page.fill('#rmLabel', label);
        await page.fill('#rmDesc', 'Created by edit-save-roles.spec.js');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator(`td:has-text("${label}")`)).toBeVisible();

        const roles   = await apiGet(page, '/api/admin/roles');
        const created = roles.find(r => r.label === label);
        expect(created, 'expected the created role to be readable via the API').toBeTruthy();
        expect(created.name).toBe(name);
        createdId = created.id;
    });

    test('editing a role label/description persists via API readback', async ({ page }) => {
        const name  = randomRoleName();
        const label = testTag('EditMe');

        await page.click('button:has-text("+ New Role")');
        await page.waitForSelector('#rmName');
        await page.fill('#rmName', name);
        await page.fill('#rmLabel', label);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });

        let roles   = await apiGet(page, '/api/admin/roles');
        let created = roles.find(r => r.label === label);
        createdId   = created.id;

        const newLabel = `${label} updated`;
        await page.locator(`tr:has-text("${label}") button:has-text("Edit")`).first().click();
        await page.waitForSelector('#rmName');
        await page.fill('#rmLabel', newLabel);
        await page.fill('#rmDesc', 'updated description');
        await page.click('button:has-text("Save")');
        await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });

        roles = await apiGet(page, '/api/admin/roles');
        const updated = roles.find(r => r.id === createdId);
        expect(updated.label).toBe(newLabel);
        expect(updated.description).toBe('updated description');
    });

    // ── search/export coverage ───────────────────────────────────────────────
    test.describe('search + export', () => {
        let idA = null;
        let labelA;

        test.beforeEach(async ({ page }) => {
            labelA = testTag('Findme');
        });

        test.afterEach(async ({ page }) => {
            if (idA) { await apiDelete(page, `/api/admin/roles/${idA}`); idA = null; }
        });

        test('Name/label search filters to a matching role', async ({ page }) => {
            await page.click('button:has-text("+ New Role")');
            await page.waitForSelector('#rmName');
            await page.fill('#rmName', randomRoleName());
            await page.fill('#rmLabel', labelA);
            await page.click('button:has-text("Save")');
            await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });

            const roles = await apiGet(page, '/api/admin/roles');
            idA = roles.find(r => r.label === labelA).id;

            await page.fill('#sf-q', 'Findme');
            await page.click('#btn-search');
            await expect(page.locator(`td:has-text("${labelA}")`)).toBeVisible();
        });

        test('"System" type search hides a newly created custom role', async ({ page }) => {
            await page.click('button:has-text("+ New Role")');
            await page.waitForSelector('#rmName');
            await page.fill('#rmName', randomRoleName());
            await page.fill('#rmLabel', labelA);
            await page.click('button:has-text("Save")');
            await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });

            const roles = await apiGet(page, '/api/admin/roles');
            idA = roles.find(r => r.label === labelA).id;

            await page.selectOption('#sf-type', 'system');
            await page.click('#btn-search');
            await expect(page.locator(`td:has-text("${labelA}")`)).not.toBeVisible();
        });

        test('resetting the search shows the role again', async ({ page }) => {
            await page.click('button:has-text("+ New Role")');
            await page.waitForSelector('#rmName');
            await page.fill('#rmName', randomRoleName());
            await page.fill('#rmLabel', labelA);
            await page.click('button:has-text("Save")');
            await expect(page.locator('#rmName')).not.toBeVisible({ timeout: 8_000 });

            const roles = await apiGet(page, '/api/admin/roles');
            idA = roles.find(r => r.label === labelA).id;

            await page.selectOption('#sf-type', 'system');
            await page.click('#btn-search');
            await expect(page.locator(`td:has-text("${labelA}")`)).not.toBeVisible();

            await page.click('#btn-reset');
            await expect(page.locator(`td:has-text("${labelA}")`)).toBeVisible();
        });

        test('CSV export button triggers a download', async ({ page }) => {
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                page.click('#btn-export'),
            ]);
            expect(download.suggestedFilename()).toBe('roles.csv');
        });
    });
});
