// @ts-check
/**
 * TC-002 — CloudFront must never mask a real API 403/404 as 200 + login.html.
 *
 * Root cause (fixed 2026-08-29): template.yaml's CloudFront distribution had
 * a `CustomErrorResponses` rule (403/404 -> 200 + login.html) intended as an
 * SPA fallback for the S3 frontend origin. CustomErrorResponses is a
 * DISTRIBUTION-wide CloudFront setting — there is no per-cache-behavior
 * override — so it ALSO rewrote every genuine 403/404 coming back from the
 * API origin (/api/*, /graphql, /health). A caller's `res.status === 403` /
 * `.json()` check never saw the truth, only login.html's HTML body (an
 * "Unexpected token '<'" on any client actually parsing the response).
 * Confirmed live: the property_owner login-isolation guard's real 403 JSON
 * was silently replaced when accessed through https://amaradata.com,
 * requiring the raw API Gateway URL to observe the real response.
 *
 * A prior session partially diagnosed this for the origin-secret-check case
 * specifically (see testing/unittests/integration/auth-routes.test.js) but
 * only asserted it against the Express app directly via supertest — which
 * never goes through CloudFront, so it could never actually catch this
 * class of bug. This check is deliberately the opposite: it only means
 * anything when run against a real CloudFront-fronted deployment
 * (PW_BASE_URL set to a real URL) — against the local dev server (no
 * CloudFront in front of it at all) it still passes, but trivially, since
 * there is no CDN layer to mask anything.
 */
import { test, expect } from '@playwright/test';

test.describe('TC-002 — CloudFront does not rewrite API 403/404 into login.html', () => {
    // 404 needs no auth setup at all (an unmatched route), which is why it's
    // the reliable, environment-agnostic reproduction here — the removed
    // CustomErrorResponses rule masked 403 via the identical mechanism, so
    // proving the rule itself is gone via one status code is sufficient;
    // it was never per-status-code logic to begin with.
    test('GET /api/<unknown-route> returns real 404 JSON, not 200 + HTML', async ({ page }) => {
        const res = await page.request.get('/api/tc-002-definitely-does-not-exist');
        expect(res.status()).toBe(404);
        expect(res.headers()['content-type']).toContain('application/json');
        const body = await res.json(); // throws if the body were HTML instead
        expect(body).toHaveProperty('error');
    });
});
