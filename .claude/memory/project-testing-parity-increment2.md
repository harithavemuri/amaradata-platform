---
name: project-testing-parity-increment2
description: "Second testing-parity increment applying rohas-group's testing strategies to amaradata-platform: smoke lifecycle, deploy wiring, edit-save Playwright coverage, role matrix, perf SLA"
metadata:
  type: project
---

Built on top of the baseline 5-layer structure ([[feedback-test-layers-db-first]]) at the user's request to "apply the same testing strategies as rohas-group." Full parity (rohas has 47 E2E specs, load/throughput testing, 21-role coverage) was explicitly scoped down by the user to 4 categories, with load/throughput testing intentionally excluded in favor of just enforcing the SLA already documented in [[feedback-performance-sla]].

**What was built:**
1. **Smoke-account lifecycle** — `scripts/smoke-lifecycle.js` enables the smoke user via the existing `PUT /api/admin/users/:id` (no new Lambda/raw-SQL, unlike rohas's approach), runs `smoke-prod.js`, disables in a `finally`, verifies the disabled account can't log in. Requires a permanent `site_admin` bootstrap account in prod (`SMOKE_BOOTSTRAP_ADMIN_USER/PASSWORD` in `.env.test` — not yet confirmed to exist; that's a one-time manual setup step outside this session's scope).
2. **Deploy wiring** — `scripts/tag-release.js` (git tag before deploy, extracted to its own script for cross-shell reliability rather than inlined `npm_package_version` substitution) and `.env.test.example` template, both wired into `npm run deploy`.
3. **Edit-save Playwright coverage** — `testing/regression_testsuite/edit-save-{enhancements,roles,user-groups,users,invoices,metrics}.spec.js` + strengthened `tenants.spec.js`, all via a shared `helpers/edit-save.js` (API-readback + zzzzzz-prefixed cleanup).
4. **Role matrix** — `testing/unittests/unit/role-guards.test.js` (exhaustive guard×role matrix), `testing/unittests/api/role-guards-routes.test.js`, `testing/regression_testsuite/role-login-smoke.spec.js`. Added missing `salesManager`/`billing` tokens to `src/test/helpers.js` and `testing/unittests/helpers.js`.
5. **Performance SLA** — `testing/unittests/integration/performance.test.js` (API ≤500ms) and a page-load ≤3s check in `login-dashboard.spec.js`.

**Real bugs found and fixed while verifying (not app bugs — all in the new test code itself):**
- Cross-file test pollution: no DELETE route exists for `tenants`, so specs creating tenants (invoices/metrics/user-groups) permanently polluted `tenants.spec.js`'s zero-tenant "empty state" assertions when run in the same suite invocation (alphabetical file order put `edit-save-*` before `tenants.spec.js`). Fixed by extracting those assertions into `00-tenants-empty-state.spec.js` — numeric prefix guarantees it always runs first. **Did not** add a tenants DELETE route — unlike `enhancements` (added a DELETE this session, safe, no FK children), tenants is the core billing entity with FK-referencing children (invoices, subscriptions, enhancements, metrics), so a hard delete is a materially riskier change that wasn't warranted just to fix test isolation.
- NonDB mode stores a `<select>`-sourced id as a raw DOM string; comparing it with `===` against a numeric id from `apiPost`'s response silently fails. Fixed with `==` (matches `FileDbService.find()`'s own established convention).
- Role `name` must match `/^[a-z_]+$/` (letters/underscores only) — a `Date.now()`-based test name contains digits and gets rejected by the backend's own validation. Fixed with `helpers/edit-save.js`'s `randomRoleName()`.
- `amr_roles` starts empty in a fresh test DB (nothing auto-seeds it) — a test that assumed a pre-existing role now creates its own.

**Why this list matters:** a prior verification pass on this same PR reported "exit code 0" from `command | tail -150` and `command 2>&1 | tail -40` — the pipe's exit code masked the real (non-zero) exit code of the actual test run underneath, so an apparently-clean pass actually had 8 failures. Always redirect to a file (`> file 2>&1`) and check the file's content directly rather than trusting a piped command's reported exit code.
