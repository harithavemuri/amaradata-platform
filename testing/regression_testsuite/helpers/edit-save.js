// @ts-check
/**
 * Shared helpers for the per-screen "edit-save" regression specs
 * (edit-save-*.spec.js) — mirrors the shape of rohas-group's
 * testing/regression_testsuite/helpers/metadata-edit-save.js, adapted to
 * amaradata's actual { success, data } response envelope and routes.
 *
 * Every edit-save spec should: (1) create/edit through the real UI,
 * (2) verify persistence via these API helpers (not just DOM state —
 * catches DB-mode routing bugs a toast/row check would miss),
 * (3) clean up in afterEach via apiDelete (or accept suite-level DB
 * truncation where no DELETE route exists — document why, in the spec).
 */
import { expect } from '@playwright/test';

/** Logs in via the real login form and returns { page } ready for use. */
export async function loginAs(page, { email, password }) {
    await page.goto('/login');
    await page.fill('#username', email);
    await page.fill('#password', password);
    await page.click('button.btn-primary');
    await page.waitForURL('**/dashboard', { timeout: 10_000 });
}

async function authHeaders(page) {
    const token = await page.evaluate(() => localStorage.getItem('amrd_token'));
    expect(token, 'expected amrd_token in localStorage after login').toBeTruthy();
    return {
        Authorization:  `Bearer ${token}`,
        Accept:         'application/json;v=1',
        'Content-Type': 'application/json',
    };
}

async function unwrap(res, method, path) {
    const json = await res.json().catch(() => ({}));
    expect(res.ok(), `${method} ${path} → HTTP ${res.status()}: ${json.error || JSON.stringify(json)}`).toBeTruthy();
    return json.data;
}

export async function apiGet(page, path) {
    const res = await page.request.get(path, { headers: await authHeaders(page) });
    return unwrap(res, 'GET', path);
}

export async function apiPost(page, path, body) {
    const res = await page.request.post(path, { headers: await authHeaders(page), data: body });
    return unwrap(res, 'POST', path);
}

export async function apiPut(page, path, body) {
    const res = await page.request.put(path, { headers: await authHeaders(page), data: body });
    return unwrap(res, 'PUT', path);
}

export async function apiPatch(page, path, body) {
    const res = await page.request.patch(path, { headers: await authHeaders(page), data: body });
    return unwrap(res, 'PATCH', path);
}

/** Delete never throws even on failure — cleanup must not mask a test's real failure. */
export async function apiDelete(page, path) {
    const headers = await authHeaders(page);
    await page.request.delete(path, { headers }).catch(() => {});
}

/**
 * Collision-safe unique suffix — Date.now() alone isn't enough once the load
 * test runs 5 concurrent OS processes that can call this within the same
 * millisecond, producing identical tags/slugs/emails and 409 conflicts.
 */
export function uniqueSuffix() {
    return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

/** zzzzzz-prefixed unique label — feedback-test-data-prefix convention. */
export function testTag(label) {
    return `zzzzzz ${label} ${uniqueSuffix()}`;
}

/** zzzzzz-prefixed unique slug (lowercase, hyphen-separated) for tenants/etc. */
export function testSlug(label) {
    return `zzzzzz-${label}-${uniqueSuffix()}`.toLowerCase();
}

/** zzzzzz-prefixed unique test email address. */
export function testEmail() {
    return `zzzzzz.${uniqueSuffix()}@test.local`;
}

/**
 * Role `name` must match backend/routes/admin.js's /^[a-z_]+$/ — letters and
 * underscores only, no digits, so testTag()/Date.now()-based names don't work here.
 */
export function randomRoleName() {
    const letters = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    return `zzzzzz_role_${letters}`;
}
