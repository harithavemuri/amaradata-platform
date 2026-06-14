---
name: feedback-performance-sla
description: Performance SLAs — API responses ≤500ms, page load ≤3s; performance tests belong at integration layer (API) and E2E layer (page load)
metadata:
  type: feedback
---

Performance SLAs for this project:
- **API responses:** ≤ 500 ms per endpoint call
- **API SLA threshold:** 500ms
- **Page load SLA threshold:** 3000ms

**Pyramid placement:**
- API response-time assertions → **Integration layer** (`src/test/integration/` or `testing/unittests/api/`). Use `Date.now()` before/after supertest call or supertest's `res.duration` if available. Fast, no browser needed.
- Page load timing → **E2E layer** (`testing/regression_testsuite/`). Use Playwright `page.goto()` with `performance.timing` or `page.metrics()`. Only covers critical journeys.
- Load/stress testing (concurrent users, throughput) → **above smoke**, not in the standard pyramid. Use a dedicated tool (k6, Artillery) only if required. Not currently needed.

**How to apply:**
- When adding a performance assertion to an API test, wrap the request with a timer and assert `duration < 500`.
- When adding a page load assertion to a Playwright spec, use `navigationStart` → `loadEventEnd` from `window.performance.timing` and assert `< 3000`.
- Do NOT add performance assertions to unit tests — they test correctness, not speed.
- Never assert sub-millisecond precision (flaky in CI). Use generous but meaningful thresholds.
- If a test consistently runs close to the SLA in CI, flag it rather than bumping the threshold.

**Why:** SLAs set by user. Performance regressions caught at the integration layer are cheap to fix; caught in production they are expensive. Page load SLA is for end-user experience; API SLA is for both frontend and any API consumers.
