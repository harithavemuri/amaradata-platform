---
name: feedback-testing-pyramid
description: Tests must follow the modern testing pyramid — unit > integration > E2E > smoke; warn when a request violates this
metadata:
  type: feedback
---

Tests must follow the modern testing pyramid strategy. Warn the user when a request would violate it.

**Pyramid layers (most → fewest):**
1. **Unit tests** — Isolated, fast, no I/O. Test a single function or module. Use mocks/stubs for all external dependencies (DB, HTTP, SES). Should be the largest group.
2. **Integration tests** — Test that components work together: route handler + DB layer, middleware chains, NonDB file-service interactions. Real DB required for DB-mode integration tests (hits `_test`-suffixed DB via `assertTestDb()`). Smaller group.
3. **E2E / UI tests (Playwright)** — Drive a real browser against a running server. Only cover critical user journeys. Fewest and slowest. Lives in `testing/regression_testsuite/`.
4. **Smoke tests** — Read-only, post-deploy validation against the live production environment. Not a substitute for E2E; they verify the deployed system is up and the critical API contracts are intact. Lives in `scripts/smoke-prod.js`. Run after every deploy via `npm run smoke`.

**Anti-patterns to warn about:**
- Writing E2E tests for logic that can be unit-tested (ice cream cone anti-pattern).
- Writing integration tests that only exercise a single function in isolation (should be unit).
- Skipping unit/integration coverage and only adding E2E — high maintenance cost, slow CI.
- Mocking the DB in integration tests — breaks the point of integration testing (see [[feedback-test-db-failsafe]]).
- Labeling NonDB supertest route tests as "unit tests" — they test route + middleware + FileDbService together, making them integration tests.
- Defining `assertJson` locally inside a test file — it belongs in `src/test/helpers.js` and `testing/unittests/helpers.js` and must be imported everywhere.
- Using smoke tests as a pre-deploy gate — smoke tests run AFTER deploy, against production. Pre-deploy gates use unit + integration + E2E.

**How to apply:**
- When asked to write a test, first classify where it belongs in the pyramid.
- If the request would sit at a higher layer than necessary, say so: "This is unit-testable — I'd recommend a unit test instead of an integration/E2E test."
- Default new test files to the correct layer:
  - Unit: `src/test/unit/` (pure functions, middleware logic, jsdom UI)
  - Integration: `src/test/integration/` (supertest + NonDB or real DB)
  - E2E: `testing/regression_testsuite/` (Playwright)
  - Smoke: `scripts/smoke-prod.js` (read-only, production only)
- Always write more unit tests than integration tests; always write more integration tests than E2E tests.
- Smoke tests are the thinnest layer — a handful of critical checks, never exhaustive.

**Performance tests (cross-cutting — see [[feedback-performance-sla]]):**
- API response time (≤500ms) → assert at **Integration layer** using a `Date.now()` timer around the supertest call
- Page load time (≤3s) → assert at **E2E layer** using `window.performance.timing` in Playwright
- Load/stress tests → outside the pyramid, use k6/Artillery only if required
- Never add performance assertions to unit tests

**Why:** Modern testing pyramid keeps CI fast, failures localised, and maintenance low. E2E tests are expensive to run and brittle; unit tests are cheap and precise. Inverting the pyramid (too many E2E) is the most common cause of slow, flaky CI. Smoke tests sit above E2E because they run in production — they are a safety net, not a test suite.
