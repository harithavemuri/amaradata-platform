// @ts-check
/**
 * Extended Playwright `test` that auto-captures per-API-call timing for every
 * test that imports it, with zero changes needed to the test body itself.
 * Specs switch to this by importing `test`/`expect` from here instead of
 * directly from '@playwright/test'.
 *
 * What gets captured per test:
 *   - API: every same-origin /api/* or /graphql response's network timing
 *     (Playwright's own Request.timing().responseEnd — start-to-finish
 *     duration in ms for that call).
 *   - DB: NOT captured — see perf-aggregate.js's header comment for why
 *     (amaradata's DB-mode routes call a shared db.query(), not a per-request
 *     query interface, so there's no cheap request-correlation hook).
 *   - UI: NOT captured here — a single test has no reliable way to measure
 *     "pure UI time" separately from waiting on the network calls above. The
 *     reporter (performance-reporter.cjs) uses Playwright's own
 *     TestResult.duration (the whole test's wall-clock time) as the UI
 *     figure instead, since that's the only time source truly external to
 *     this fixture.
 *
 * The raw per-call list is handed off via testInfo.attach() rather than
 * computed here, so the actual aggregation math (sums/averages) stays in
 * perf-aggregate.js where it's unit-tested — this file is intentionally thin
 * glue, not logic.
 */
import { test as base, expect } from '@playwright/test';

const API_URL_PATTERN = /\/(api|graphql)(\/|$|\?)/;

export const test = base.extend({
    page: async ({ page }, use, testInfo) => {
        /** @type {Array<{url: string, method: string, status: number, durationMs: number|null}>} */
        const calls = [];
        // The 'requestfinished' handler below is async (awaits request.response())
        // — tracked here so teardown can wait for every in-flight one to finish
        // recording before reading `calls`, instead of racing whatever happened
        // to have already pushed by the time the test body returned.
        const pending = [];

        // 'requestfinished' (not 'response') — Request.timing() isn't
        // guaranteed populated until the request has actually finished
        // downloading; reading it from the 'response' handler (which fires as
        // soon as headers arrive) measures apiTotalMs as 0 for every call.
        page.on('requestfinished', (request) => {
            const url = request.url();
            if (!API_URL_PATTERN.test(url)) return;

            const recorded = (async () => {
                let response = null;
                try {
                    response = await request.response();
                } catch { /* best effort */ }
                if (!response) return;

                let durationMs = null;
                try {
                    const timing = request.timing();
                    if (timing && typeof timing.responseEnd === 'number' && timing.responseEnd >= 0) {
                        durationMs = timing.responseEnd;
                    }
                } catch { /* timing unavailable — best effort */ }

                calls.push({ url, method: request.method(), status: response.status(), durationMs });
            })();
            pending.push(recorded);
        });

        await use(page);

        // Runs after the test body completes (pass or fail) — wait for every
        // in-flight recording to actually finish before reading `calls`.
        await Promise.all(pending);
        await testInfo.attach('perf-calls', {
            body: JSON.stringify(calls),
            contentType: 'application/json',
        });
    },
});

export { expect };
