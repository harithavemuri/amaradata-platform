// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiPost, apiDelete, testTag, testEmail } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

let createdId = null;

test.describe('Users — edit/save coverage (site_admin only)', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        await page.goto('/users');
        await page.waitForSelector('#usersTable', { timeout: 10_000 });
    });

    test.afterEach(async ({ page }) => {
        // DELETE is a soft-delete (is_active=false) — safe/idempotent even if the test already deactivated it.
        if (createdId) { await apiDelete(page, `/api/admin/users/${createdId}`); createdId = null; }
    });

    test('adding a user persists via API readback', async ({ page }) => {
        const name  = testTag('User');
        const email = testEmail();

        await page.click('button:has-text("+ Add User")');
        await page.waitForSelector('#fName');
        await page.fill('#fName', name);
        await page.fill('#fEmail', email);
        await page.fill('#fPassword', 'TempPassw0rd!');
        await page.click('button:has-text("Save")');

        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });
        await expect(page.locator(`td:has-text("${name}")`)).toBeVisible();

        const users   = await apiGet(page, '/api/admin/users');
        const created = users.find(u => u.email === email);
        expect(created, 'expected the created user to be readable via the API').toBeTruthy();
        expect(created.name).toBe(name);
        createdId = created.id;
    });

    test('editing a user\'s name persists via API readback', async ({ page }) => {
        const name  = testTag('EditMe');
        const email = testEmail();

        await page.click('button:has-text("+ Add User")');
        await page.waitForSelector('#fName');
        await page.fill('#fName', name);
        await page.fill('#fEmail', email);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });

        let users   = await apiGet(page, '/api/admin/users');
        let created = users.find(u => u.email === email);
        createdId   = created.id;

        const newName = `${name} updated`;
        await page.locator(`tr:has-text("${name}") button:has-text("Edit")`).first().click();
        await page.waitForSelector('#fName');
        await page.fill('#fName', newName);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });

        users = await apiGet(page, '/api/admin/users');
        const updated = users.find(u => u.id === createdId);
        expect(updated.name).toBe(newName);
    });

    test('deactivating and reactivating a user persists via API readback', async ({ page }) => {
        const name  = testTag('ToggleMe');
        const email = testEmail();

        await page.click('button:has-text("+ Add User")');
        await page.waitForSelector('#fName');
        await page.fill('#fName', name);
        await page.fill('#fEmail', email);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });

        let users   = await apiGet(page, '/api/admin/users');
        let created = users.find(u => u.email === email);
        createdId   = created.id;
        expect(created.is_active).not.toBe(false);

        page.once('dialog', d => d.accept());
        await page.locator(`tr:has-text("${name}") button:has-text("Deactivate")`).first().click();
        await page.waitForTimeout(500); // confirm() dialog + reload

        users = await apiGet(page, '/api/admin/users');
        expect(users.find(u => u.id === createdId).is_active).toBe(false);

        // Reactivate — the same button toggles label/handler based on current is_active.
        page.once('dialog', d => d.accept());
        await page.locator(`tr:has-text("${name}") button:has-text("Reactivate")`).first().click();
        await page.waitForTimeout(500);

        users = await apiGet(page, '/api/admin/users');
        expect(users.find(u => u.id === createdId).is_active).not.toBe(false);
    });

    // No role field exists anywhere in users.html's Add/Edit modal (confirmed:
    // saveUser() only ever sends {email, name} on create and {name, is_active}
    // on edit) — role assignment isn't editable from this screen at all, so
    // there is no UI path here for a "change a user's role" test to drive.

    test('changing a user\'s password persists — verified via a real login with the new password', async ({ page, browser }) => {
        const name        = testTag('PasswordChange');
        const email       = testEmail();
        const oldPassword = 'OldPassw0rd!';
        const newPassword = 'NewPassw0rd!';

        await page.click('button:has-text("+ Add User")');
        await page.waitForSelector('#fName');
        await page.fill('#fName', name);
        await page.fill('#fEmail', email);
        await page.fill('#fPassword', oldPassword);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });

        const users   = await apiGet(page, '/api/admin/users');
        const created = users.find(u => u.email === email);
        createdId     = created.id;

        await page.locator(`tr:has-text("${name}") button:has-text("Edit")`).first().click();
        await page.waitForSelector('#fName');
        await page.fill('#fPassword', newPassword);
        await page.click('button:has-text("Save")');
        await expect(page.locator('#fName')).not.toBeVisible({ timeout: 8_000 });

        // password_hash is never returned by the API (_safeUser strips it) — the
        // only real way to verify a password change took effect is logging in
        // with it. A same-context context.newPage() is NOT enough here — pages
        // in the same browser context share localStorage/cookies, so the
        // already-logged-in site_admin session leaks in and login.html's
        // already-logged-in redirect blocks #username from ever rendering
        // (same underlying issue as the nested-describe login bug, different
        // mechanism). Use a genuinely separate browser context instead.
        const loginContext = await browser.newContext();
        const loginPage    = await loginContext.newPage();
        await loginPage.goto('/login');
        await loginPage.fill('#username', email);
        await loginPage.fill('#password', newPassword);
        await loginPage.click('button.btn-primary');
        await loginPage.waitForURL('**/dashboard', { timeout: 10_000 });
        expect(loginPage.url()).toContain('/dashboard');
        await loginContext.close();
    });

    // ── search/read coverage ─────────────────────────────────────────────────
    // users.html's search fields (#sf-q/#sf-status/#sf-group) are a client-side
    // filter over the already-fetched user list — no API call to verify, just
    // that clicking Search narrows the visible <tr>s correctly.
    test.describe('search', () => {
        let idA = null;
        let idB = null;
        let nameA;
        let nameB;

        test.beforeEach(async ({ page }) => {
            nameA = testTag('Findme');
            nameB = testTag('Other');
            const userA = await apiPost(page, '/api/admin/users', { name: nameA, email: testEmail() });
            idA = userA.id;
            const userB = await apiPost(page, '/api/admin/users', { name: nameB, email: testEmail() });
            idB = userB.id;

            await page.goto('/users');
            await page.waitForSelector('#usersTable', { timeout: 10_000 });
        });

        test.afterEach(async ({ page }) => {
            if (idA) await apiDelete(page, `/api/admin/users/${idA}`);
            if (idB) await apiDelete(page, `/api/admin/users/${idB}`);
            idA = idB = null;
        });

        test('typing a name that matches only one user hides the other', async ({ page }) => {
            await expect(page.locator(`tr:has-text("${nameA}")`)).toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).toBeVisible();

            await page.fill('#sf-q', 'Findme');
            await page.click('#btn-search');

            await expect(page.locator(`tr:has-text("${nameA}")`)).toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).not.toBeVisible();
        });

        test('resetting the search shows both users again', async ({ page }) => {
            await page.fill('#sf-q', 'Findme');
            await page.click('#btn-search');
            await expect(page.locator(`tr:has-text("${nameB}")`)).not.toBeVisible();

            await page.click('#btn-reset');

            await expect(page.locator(`tr:has-text("${nameA}")`)).toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).toBeVisible();
        });

        test('"Inactive" status search hides an active user', async ({ page }) => {
            await page.selectOption('#sf-status', 'inactive');
            await page.click('#btn-search');

            await expect(page.locator(`tr:has-text("${nameA}")`)).not.toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).not.toBeVisible();
        });

        test('CSV export button triggers a download', async ({ page }) => {
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                page.click('#btn-export'),
            ]);
            expect(download.suggestedFilename()).toBe('users.csv');
        });
    });
});
