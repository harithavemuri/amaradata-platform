// @ts-check
/**
 * Shared helpers for testing/release-tracking/checks/TC-*.spec.js.
 * Mirrors the shape of rohas-group's testing/release-tracking/checks/helpers/prod-verify.js.
 */
import { expect } from '@playwright/test';

export const LOCAL_ADMIN = {
    email:    'release-checks-admin@test.local',
    password: 'ReleaseChecks123!',
};

// When PW_BASE_URL is set (a real deployed environment), credentials come from
// the same env vars scripts/smoke-prod.js uses — never hardcode real prod passwords.
const REMOTE = !!process.env.PW_BASE_URL;
export const USERNAME = REMOTE ? process.env.SMOKE_TEST_USER            : LOCAL_ADMIN.email;
export const PASSWORD = REMOTE ? process.env.SMOKE_TEST_ADMIN_PASSWORD  : LOCAL_ADMIN.password;

/** Logs in via the real login form and returns Bearer headers for API calls. */
export async function login(page) {
    if (REMOTE && (!USERNAME || !PASSWORD)) {
        throw new Error('Set SMOKE_TEST_USER / SMOKE_TEST_ADMIN_PASSWORD to run release checks against PW_BASE_URL.');
    }
    await page.goto('/login');
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('amrd_token'));
    expect(token, 'expected amrd_token in localStorage after login').toBeTruthy();
    return {
        Authorization: `Bearer ${token}`,
        Accept:        'application/json;v=1',
        'Content-Type': 'application/json',
    };
}
