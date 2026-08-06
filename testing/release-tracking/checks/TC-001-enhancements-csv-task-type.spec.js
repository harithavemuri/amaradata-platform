// @ts-check
/**
 * TC-001 — Enhancements CSV import: Type=Task must normalize to item_type=enhancement.
 *
 * Root cause (fixed same day as this check was added): frontend/enhancements.html's
 * importCsv() lowercased the sheet's Type column verbatim (`'Task' -> 'task'`), but the
 * enhancements screen's type filter and the DB only recognize 'bug'/'enhancement'. A
 * Task-type row (e.g. a tenant's "Task" work item, always billable per
 * .claude/skills/fix-issues.md) imported successfully but became invisible under the
 * "Enhancements" filter — silently dropping it from the billing-relevant view.
 *
 * This check drives the real upload UI (not the API directly — the bug was in the
 * browser-side mapping code, so bypassing the UI would not exercise the fix) with a
 * synthetic CSV containing one Type=Task row, then asserts it appears when filtering
 * by "Enhancements".
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers/verify.js';

// zzzzzz prefix marks this as test data per feedback-test-data-prefix.
const MARKER   = `zzzzzz TC-001 ${Date.now()}`;
const ISSUE_ID = Date.now() % 1_000_000; // unlikely to collide with any real issue_id

function buildCsv() {
    return [
        'IssueId,Report Date,Notes,Site Name,Tenant Name,Apply Fix?,Fixed?,Fix Details,Type,Billable',
        `${ISSUE_ID},July 26 2026,${MARKER},zzzzzz-test-site,Rohas Group,Yes,Yes,Verified via TC-001,Task,No`,
    ].join('\n');
}

test.describe('TC-001 — Enhancements CSV Type=Task normalization', () => {
    let hdrs;
    let createdId;

    test.beforeEach(async ({ page }) => {
        hdrs = await login(page);
    });

    test.afterEach(async ({ page }) => {
        // Best-effort cleanup — see feedback-test-data-prefix: the zzzzzz prefix is the
        // safety net if this doesn't run, not a substitute for it.
        if (createdId) {
            await page.request.delete(`/api/enhancements/${createdId}`, { headers: hdrs }).catch(() => {});
        }
    });

    test('a Type=Task row imports as item_type=enhancement and is visible under the Enhancements filter', async ({ page }) => {
        await page.goto('/enhancements');

        await page.click('button:has-text("Upload CSV")');
        await page.setInputFiles('#imp-file', {
            name:     'tc-001.csv',
            mimeType: 'text/csv',
            buffer:   Buffer.from(buildCsv()),
        });
        await page.click('#import-panel button:has-text("Import")');

        await expect(page.locator('#imp-result')).toContainText('1 inserted', { timeout: 10_000 });

        // Filter to Enhancements only — this is exactly where the bug made the row vanish.
        await page.selectOption('#sf-type', 'enhancement');
        await page.click('#btn-search');
        const row = page.locator('tr', { hasText: MARKER });
        await expect(row, 'Task-type row must be visible under the Enhancements filter').toBeVisible({ timeout: 10_000 });
        await expect(row.locator('td', { hasText: 'Enhancement' })).toBeVisible();

        // Confirm the underlying data too, not just the DOM — via the API used to look up the id for cleanup.
        const res  = await page.request.get('/api/enhancements', { headers: hdrs });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const created = body.data.find((e) => e.issue_id === ISSUE_ID);
        expect(created, 'expected the imported row to be present via the API too').toBeTruthy();
        expect(created.item_type).toBe('enhancement');
        createdId = created.id;
    });
});
