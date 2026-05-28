// @ts-check
import { test, expect } from '@playwright/test';

// ── Shared credentials (seeded in global-setup.js) ────────────────────────────
const ADMIN = {
    email:    'playwright-admin@test.local',
    password: 'PlaywrightTest123!',
    name:     'Playwright Admin',
    role:     'admin',
};

// Helper: logs in via the UI form and waits for /dashboard
async function loginAdmin(page) {
    await page.goto('/login');
    await page.fill('#email',    ADMIN.email);
    await page.fill('#password', ADMIN.password);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 5_000 });
}

// ── Login page ────────────────────────────────────────────────────────────────
test.describe('Login page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/login');
    });

    test('page title is "Sign In — AmaraData Platform"', async ({ page }) => {
        await expect(page).toHaveTitle('Sign In — AmaraData Platform');
    });

    test('AmaraData logo and Platform Console subtitle are visible', async ({ page }) => {
        await expect(page.locator('.logo-title')).toHaveText('AmaraData');
        await expect(page.locator('.logo-sub')).toHaveText('Platform Console');
    });

    test('email field, password field and Sign In button are present', async ({ page }) => {
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('button.btn-primary')).toHaveText('Sign In');
    });

    test('empty form submission shows required-fields error', async ({ page }) => {
        await page.click('button.btn-primary');
        await expect(page.locator('#errMsg')).toHaveText('Email and password are required');
        await expect(page.url()).not.toContain('/dashboard');
    });

    test('wrong password shows error and stays on login', async ({ page }) => {
        await page.fill('#email',    ADMIN.email);
        await page.fill('#password', 'wrong-password-xyz');
        await page.click('button.btn-primary');

        await expect(page.locator('#errMsg')).toBeVisible();
        await expect(page.locator('#errMsg').innerText()).resolves.toBeTruthy();
        await expect(page.url()).not.toContain('/dashboard');
    });

    test('unknown email shows error and stays on login', async ({ page }) => {
        await page.fill('#email',    'nobody@doesnotexist.com');
        await page.fill('#password', 'somepassword');
        await page.click('button.btn-primary');

        await expect(page.locator('#errMsg')).toBeVisible();
        await expect(page.url()).not.toContain('/dashboard');
    });

    test('Enter key in form triggers login', async ({ page }) => {
        await page.fill('#email',    ADMIN.email);
        await page.fill('#password', ADMIN.password);
        await page.keyboard.press('Enter');

        // Should show success message before redirect
        await expect(page.locator('#okMsg')).toHaveText('Signed in! Redirecting…');
        await page.waitForURL('**/dashboard', { timeout: 5_000 });
    });
});

// ── Successful login flow ─────────────────────────────────────────────────────
test.describe('Admin login flow', () => {
    test('admin credentials → success message → redirect to /dashboard', async ({ page }) => {
        await page.goto('/login');
        await page.fill('#email',    ADMIN.email);
        await page.fill('#password', ADMIN.password);
        await page.click('button.btn-primary');

        // Intermediate success state
        await expect(page.locator('#okMsg')).toHaveText('Signed in! Redirecting…');
        await expect(page.locator('button.btn-primary')).toBeDisabled();

        // Dashboard redirect
        await page.waitForURL('**/dashboard', { timeout: 5_000 });
        expect(page.url()).toContain('/dashboard');
    });

    test('already-logged-in user visiting /login is redirected to /dashboard', async ({ page }) => {
        // Log in once
        await loginAdmin(page);

        // Visit login again — should bounce to dashboard
        await page.goto('/login');
        await page.waitForURL('**/dashboard', { timeout: 5_000 });
        expect(page.url()).toContain('/dashboard');
    });
});

// ── Dashboard page & sidebar ──────────────────────────────────────────────────
test.describe('Dashboard — sidebar fully rendered (admin role)', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
    });

    // ── Page basics ───────────────────────────────────────────────────────────
    test('page title is "Dashboard — AmaraData Platform"', async ({ page }) => {
        await expect(page).toHaveTitle('Dashboard — AmaraData Platform');
    });

    test('URL is /dashboard', async ({ page }) => {
        expect(page.url()).toContain('/dashboard');
    });

    // ── Sidebar container ─────────────────────────────────────────────────────
    test('sidebar (.amrd-sidebar) is visible', async ({ page }) => {
        await expect(page.locator('.amrd-sidebar')).toBeVisible();
    });

    // ── Logo ──────────────────────────────────────────────────────────────────
    test('sidebar shows AmaraData logo title', async ({ page }) => {
        await expect(page.locator('.amrd-sidebar .amrd-logo-title')).toHaveText('AmaraData');
    });

    test('sidebar shows "Platform Console" subtitle', async ({ page }) => {
        await expect(page.locator('.amrd-sidebar .amrd-logo-sub')).toHaveText('Platform Console');
    });

    test('logo is a link pointing to /', async ({ page }) => {
        await expect(page.locator('.amrd-sidebar a.amrd-logo')).toHaveAttribute('href', '/');
    });

    // ── Main navigation items ─────────────────────────────────────────────────
    test('Dashboard nav link is present', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/dashboard"]')).toBeVisible();
    });

    test('Tenants nav link is present', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/tenants"]')).toBeVisible();
    });

    test('Invoices nav link is present', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/invoices"]')).toBeVisible();
    });

    test('Enhancements nav link is present', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/enhancements"]')).toBeVisible();
    });

    test('Billing Metrics nav link is present', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/metrics"]')).toBeVisible();
    });

    test('all 5 main nav links are visible', async ({ page }) => {
        const nav = page.locator('.amrd-nav');
        await expect(nav.locator('a[href="/dashboard"]')).toBeVisible();
        await expect(nav.locator('a[href="/tenants"]')).toBeVisible();
        await expect(nav.locator('a[href="/invoices"]')).toBeVisible();
        await expect(nav.locator('a[href="/enhancements"]')).toBeVisible();
        await expect(nav.locator('a[href="/metrics"]')).toBeVisible();
    });

    test('Dashboard nav link has "active" class (current page)', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/dashboard"]')).toHaveClass(/active/);
    });

    test('non-active nav links do not have "active" class', async ({ page }) => {
        for (const href of ['/tenants', '/invoices', '/enhancements', '/metrics']) {
            await expect(page.locator(`.amrd-nav a[href="${href}"]`)).not.toHaveClass(/active/);
        }
    });

    test('nav link labels match expected text', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/dashboard"]')).toContainText('Dashboard');
        await expect(page.locator('.amrd-nav a[href="/tenants"]')).toContainText('Tenants');
        await expect(page.locator('.amrd-nav a[href="/invoices"]')).toContainText('Invoices');
        await expect(page.locator('.amrd-nav a[href="/enhancements"]')).toContainText('Enhancements');
        await expect(page.locator('.amrd-nav a[href="/metrics"]')).toContainText('Billing Metrics');
    });

    // ── Admin guard: User Management hidden ───────────────────────────────────
    test('"User Management" section is NOT shown for admin role', async ({ page }) => {
        await expect(page.locator('text=User Management')).not.toBeVisible();
    });

    test('Users admin link is NOT in sidebar', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/users"]')).not.toBeVisible();
    });

    test('User Groups admin link is NOT in sidebar', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/user-groups"]')).not.toBeVisible();
    });

    test('Roles admin link is NOT in sidebar', async ({ page }) => {
        await expect(page.locator('.amrd-nav a[href="/roles"]')).not.toBeVisible();
    });

    // ── User info section ─────────────────────────────────────────────────────
    test('sidebar user section shows logged-in user name', async ({ page }) => {
        await expect(page.locator('.amrd-user-name')).toHaveText(ADMIN.name);
    });

    test('sidebar user section shows role', async ({ page }) => {
        await expect(page.locator('.amrd-user-role')).toHaveText(ADMIN.role);
    });

    test('Sign out button is visible in sidebar', async ({ page }) => {
        await expect(page.locator('button.amrd-logout')).toBeVisible();
        await expect(page.locator('button.amrd-logout')).toContainText('Sign out');
    });

    // ── Topbar ────────────────────────────────────────────────────────────────
    test('topbar shows "Dashboard" as page title', async ({ page }) => {
        await expect(page.locator('.amrd-topbar-title')).toHaveText('Dashboard');
    });

    test('"Sync to DB" button is NOT shown for admin role (site_admin only)', async ({ page }) => {
        await expect(page.locator('#amrd-sync-btn')).not.toBeVisible();
    });

    test('hamburger toggle button is visible in topbar', async ({ page }) => {
        await expect(page.locator('button.amrd-hamburger')).toBeVisible();
    });

    // ── Sign out ──────────────────────────────────────────────────────────────
    test('clicking Sign out clears session and redirects to /login', async ({ page }) => {
        await page.click('button.amrd-logout');
        await page.waitForURL('**/login', { timeout: 5_000 });
        expect(page.url()).toContain('/login');

        // localStorage should be cleared
        const token = await page.evaluate(() => localStorage.getItem('amrd_token'));
        expect(token).toBeNull();
    });
});

// ── Logout and protected-route redirect flow ──────────────────────────────────
test.describe('Logout — post-logout navigation guards', () => {
    test.beforeEach(async ({ page }) => {
        await loginAdmin(page);
    });

    test('after logout, navigating to /dashboard shows login page', async ({ page }) => {
        // Sign out
        await page.click('button.amrd-logout');
        await page.waitForURL('**/login', { timeout: 5_000 });

        // Attempt to visit a protected page
        await page.goto('/dashboard');

        // Should be on the login page (either redirected or served login.html)
        await expect(page).toHaveURL(/\/login/);
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('button.btn-primary')).toHaveText('Sign In');
    });

    test('after logout, clicking Sign In on the login page stays on login — not dashboard', async ({ page }) => {
        // Sign out
        await page.click('button.amrd-logout');
        await page.waitForURL('**/login', { timeout: 5_000 });

        // Navigate to /dashboard then follow the Sign In button back to login
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login/);

        // Clicking the Sign In button without credentials should show an error, not /dashboard
        await page.click('button.btn-primary');
        await expect(page.locator('#errMsg')).toHaveText('Email and password are required');
        await expect(page.url()).not.toContain('/dashboard');
    });

    test('after logout, signing back in works and lands on /dashboard', async ({ page }) => {
        // Sign out
        await page.click('button.amrd-logout');
        await page.waitForURL('**/login', { timeout: 5_000 });

        // Sign in again with the same credentials
        await page.fill('#email',    ADMIN.email);
        await page.fill('#password', ADMIN.password);
        await page.click('button.btn-primary');
        await page.waitForURL('**/dashboard', { timeout: 5_000 });

        expect(page.url()).toContain('/dashboard');
        await expect(page.locator('.amrd-topbar-title')).toHaveText('Dashboard');
    });
});
