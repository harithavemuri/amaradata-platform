// @ts-check
// email.html isn't a persisted-and-later-edited record like the edit-save-*
// specs (its POSTs are send/reply actions), so it doesn't fit that helper's
// create->API-readback pattern — covered here instead.
//
// EMAIL_BUCKET is never set for this suite's server (server-entry.js), so
// inbox/get/attachment routes correctly 503 "not configured" — that's the
// real state of a fresh/local environment, and is itself worth covering.
// /send and /:id/reply don't need EMAIL_BUCKET and run in SES dev-mode
// (SES_FROM_EMAIL unset — see backend/routes/email.js's sendRaw()), so the
// actual compose-and-send flow is safe to drive for real here.
import { test, expect } from './helpers/perf-tracking.js';
import { SEED_USERS } from './helpers/seed-users.js';

async function login(page, user) {
    await page.goto('/login');
    await page.fill('#username', user.email);
    await page.fill('#password', user.password);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 10_000 });
}

test.describe('Email page', () => {
    test.beforeEach(async ({ page }) => {
        await login(page, SEED_USERS.admin);
        await page.goto('/email');
        await page.waitForSelector('#email-items', { timeout: 10_000 });
    });

    test('page title and Inbox header render', async ({ page }) => {
        await expect(page).toHaveTitle('Email — AmaraData Platform');
        await expect(page.locator('.compose-bar-title')).toHaveText('Inbox');
    });

    test('inbox shows the EMAIL_BUCKET-not-configured error (real state with no bucket set)', async ({ page }) => {
        await expect(page.locator('#email-items')).toContainText('EMAIL_BUCKET not configured');
    });

    test('empty pane prompts to select an email', async ({ page }) => {
        await expect(page.locator('.empty-pane')).toHaveText('Select an email to read');
    });

    test('Compose opens a modal with To/Subject/Message fields', async ({ page }) => {
        await page.click('#btn-compose');
        await expect(page.locator('#compose-modal')).toBeVisible();
        await expect(page.locator('.modal-title')).toHaveText('New Email');
        await expect(page.locator('#cm-to')).toBeVisible();
        await expect(page.locator('#cm-subject')).toBeVisible();
        await expect(page.locator('#cm-body')).toBeVisible();
    });

    test('Cancel closes the compose modal', async ({ page }) => {
        await page.click('#btn-compose');
        await page.click('#cm-cancel');
        await expect(page.locator('#compose-modal')).not.toBeVisible();
    });

    test('sending with empty To/Subject shows a validation alert (no real send attempted)', async ({ page }) => {
        await page.click('#btn-compose');
        let alertMessage = '';
        page.once('dialog', async (dialog) => { alertMessage = dialog.message(); await dialog.accept(); });
        await page.click('#cm-send');
        await expect.poll(() => alertMessage).toContain('to and subject are required');
        // Modal stays open — the send failed client-side visibly, not silently.
        await expect(page.locator('#compose-modal')).toBeVisible();
    });

    test('sending a valid new email succeeds and closes the modal (SES dev-mode, no real send)', async ({ page }) => {
        await page.click('#btn-compose');
        await page.fill('#cm-to', 'customer@example.com');
        await page.fill('#cm-subject', 'zzzzzz Playwright compose test');
        await page.fill('#cm-body', 'Hello from the regression suite.');
        await page.click('#cm-send');
        await expect(page.locator('#compose-modal')).not.toBeVisible({ timeout: 8_000 });
    });
});
