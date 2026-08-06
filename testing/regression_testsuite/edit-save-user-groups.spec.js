// @ts-check
import { test, expect } from './helpers/perf-tracking.js';
import { loginAs, apiGet, apiPost, apiDelete, testTag, testSlug, testEmail, randomRoleName } from './helpers/edit-save.js';
import { SEED_USERS } from './helpers/seed-users.js';

test.describe('User Groups — edit/save coverage (site_admin only)', () => {
    test.beforeEach(async ({ page }) => {
        await loginAs(page, SEED_USERS.site_admin);
        await page.goto('/user-groups');
        await page.waitForSelector('.amrd-flex-row', { timeout: 10_000 });
    });

    // ── group create/edit ────────────────────────────────────────────────────
    test.describe('group create/edit', () => {
        let createdId = null;
        test.afterEach(async ({ page }) => {
            if (createdId) { await apiDelete(page, `/api/admin/user-groups/${createdId}`); createdId = null; }
        });

        test('creating a group persists via API readback', async ({ page }) => {
            const name = testTag('Group');

            await page.click('button:has-text("+ New Group")');
            await page.waitForSelector('#gmName');
            await page.fill('#gmName', name);
            await page.fill('#gmDesc', 'Created by edit-save-user-groups.spec.js');
            await page.click('button:has-text("Save")');

            await expect(page.locator('#gmName')).not.toBeVisible({ timeout: 8_000 });
            await expect(page.locator(`text=${name}`)).toBeVisible();

            const groups  = await apiGet(page, '/api/admin/user-groups');
            const created = groups.find(g => g.name === name);
            expect(created, 'expected the created group to be readable via the API').toBeTruthy();
            createdId = created.id;
        });

        test('editing a group name/description persists via API readback', async ({ page }) => {
            const name = testTag('EditMe');

            await page.click('button:has-text("+ New Group")');
            await page.waitForSelector('#gmName');
            await page.fill('#gmName', name);
            await page.click('button:has-text("Save")');
            await expect(page.locator('#gmName')).not.toBeVisible({ timeout: 8_000 });

            let groups  = await apiGet(page, '/api/admin/user-groups');
            let created = groups.find(g => g.name === name);
            createdId   = created.id;

            const newName = `${name} updated`;
            const newDesc = testTag('updated description');
            await page.locator(`tr:has-text("${name}") button:has-text("Edit")`).first().click();
            await page.waitForSelector('#gmName');
            await page.fill('#gmName', newName);
            await page.fill('#gmDesc', newDesc);
            await page.click('button:has-text("Save")');
            await expect(page.locator('#gmName')).not.toBeVisible({ timeout: 8_000 });

            groups = await apiGet(page, '/api/admin/user-groups');
            const updated = groups.find(g => g.id === createdId);
            expect(updated.name).toBe(newName);
            expect(updated.description).toBe(newDesc);
        });
    });

    // ── member sub-resource ──────────────────────────────────────────────────
    test.describe('member add/remove', () => {
        let groupId = null;
        let userId  = null;

        test.beforeEach(async ({ page }) => {
            const group = await apiPost(page, '/api/admin/user-groups', { name: testTag('MemberGroup') });
            groupId = group.id;
            const user = await apiPost(page, '/api/admin/users', {
                email: testEmail(), name: testTag('Member'),
            });
            userId = user.id;
        });

        test.afterEach(async ({ page }) => {
            if (groupId) await apiDelete(page, `/api/admin/user-groups/${groupId}`);
            if (userId)  await apiDelete(page, `/api/admin/users/${userId}`);
            groupId = userId = null;
        });

        test('adding and removing a member persists via API readback', async ({ page }) => {
            await page.reload();
            await page.waitForSelector('.amrd-flex-row', { timeout: 10_000 });

            const group = await apiGet(page, '/api/admin/user-groups');
            const name  = group.find(g => g.id === groupId).name;
            await page.locator(`tr:has-text("${name}")`).first().click();
            await page.waitForSelector('#addMemberSelect');

            await page.selectOption('#addMemberSelect', String(userId));
            await page.click('button:has-text("Add")');
            await page.waitForTimeout(500);

            let groups = await apiGet(page, '/api/admin/user-groups');
            let updated = groups.find(g => g.id === groupId);
            expect(updated.members.some(m => m.id === userId), 'expected member to be added').toBeTruthy();

            await page.locator('button:has-text("Remove")').first().click();
            await page.waitForTimeout(500);

            groups  = await apiGet(page, '/api/admin/user-groups');
            updated = groups.find(g => g.id === groupId);
            expect(updated.members.some(m => m.id === userId), 'expected member to be removed').toBeFalsy();
        });
    });

    // ── tenant-assignment sub-resource ───────────────────────────────────────
    test.describe('tenant assignment add/remove', () => {
        let groupId  = null;
        let tenantId = null;
        let roleId   = null;

        test.beforeEach(async ({ page }) => {
            const group = await apiPost(page, '/api/admin/user-groups', { name: testTag('TenantAssnGroup') });
            groupId = group.id;
            const tenant = await apiPost(page, '/api/tenants', { name: testTag('Tenant'), slug: testSlug('tenant') });
            tenantId = tenant.id;
            // Don't assume any role already exists — amr_roles starts empty in a fresh
            // test DB (nothing auto-seeds it), so create our own.
            const role = await apiPost(page, '/api/admin/roles', { name: randomRoleName(), label: testTag('TenantAssnRole') });
            roleId = role.id;
        });

        test.afterEach(async ({ page }) => {
            if (groupId) await apiDelete(page, `/api/admin/user-groups/${groupId}`);
            if (roleId)  await apiDelete(page, `/api/admin/roles/${roleId}`);
            groupId = tenantId = roleId = null;
        });

        test('assigning and removing a tenant+role persists via API readback', async ({ page }) => {
            await page.reload();
            await page.waitForSelector('.amrd-flex-row', { timeout: 10_000 });

            const group = await apiGet(page, '/api/admin/user-groups');
            const name  = group.find(g => g.id === groupId).name;
            await page.locator(`tr:has-text("${name}")`).first().click();
            await page.waitForSelector('#addTenantSelect');

            await page.selectOption('#addTenantSelect', String(tenantId));
            await page.selectOption('#addRoleSelect', String(roleId));
            await page.click('button:has-text("Assign Tenant + Role")');
            await page.waitForTimeout(500);

            let groups  = await apiGet(page, '/api/admin/user-groups');
            let updated = groups.find(g => g.id === groupId);
            const assn  = updated.tenant_assignments.find(a => a.tenant_id === tenantId);
            expect(assn, 'expected tenant assignment to be created').toBeTruthy();

            page.once('dialog', d => d.accept());
            await page.locator('button:has-text("Remove")').first().click();
            await page.waitForTimeout(500);

            groups  = await apiGet(page, '/api/admin/user-groups');
            updated = groups.find(g => g.id === groupId);
            expect(updated.tenant_assignments.some(a => a.tenant_id === tenantId), 'expected tenant assignment to be removed').toBeFalsy();
        });
    });

    // ── search/export coverage ───────────────────────────────────────────────
    test.describe('search + export', () => {
        let idA = null;
        let idB = null;
        let nameA;
        let nameB;

        test.beforeEach(async ({ page }) => {
            nameA = testTag('Findme');
            nameB = testTag('Other');
            const groupA = await apiPost(page, '/api/admin/user-groups', { name: nameA });
            idA = groupA.id;
            const groupB = await apiPost(page, '/api/admin/user-groups', { name: nameB });
            idB = groupB.id;

            await page.reload();
            await page.waitForSelector('.amrd-flex-row', { timeout: 10_000 });
        });

        test.afterEach(async ({ page }) => {
            if (idA) await apiDelete(page, `/api/admin/user-groups/${idA}`);
            if (idB) await apiDelete(page, `/api/admin/user-groups/${idB}`);
            idA = idB = null;
        });

        test('Name search filters to a matching group', async ({ page }) => {
            await page.fill('#sf-q', 'Findme');
            await page.click('#btn-search');

            await expect(page.locator(`tr:has-text("${nameA}")`)).toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).not.toBeVisible();
        });

        test('resetting the search shows both groups again', async ({ page }) => {
            await page.fill('#sf-q', 'Findme');
            await page.click('#btn-search');
            await expect(page.locator(`tr:has-text("${nameB}")`)).not.toBeVisible();

            await page.click('#btn-reset');

            await expect(page.locator(`tr:has-text("${nameA}")`)).toBeVisible();
            await expect(page.locator(`tr:has-text("${nameB}")`)).toBeVisible();
        });

        test('CSV export button triggers a download', async ({ page }) => {
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                page.click('#btn-export'),
            ]);
            expect(download.suggestedFilename()).toBe('user-groups.csv');
        });
    });
});
