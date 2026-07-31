---
name: project-performance-framework
description: "Built rohas-group-equivalent performance benchmark/load/throughput testing framework for amaradata-platform — what exists, what's deliberately different, real bugs found"
metadata:
  type: project
---

Built at the user's explicit request ("similar testing framework to be built on amaradata"), after they noticed `testing/performance-testdata/` was empty and clarified they wanted rohas-group's actual framework, not just the lightweight SLA assertions from the prior testing-parity increment ([[project-testing-parity-increment2]]).

**What exists now:**
1. **Performance-benchmark history** — every regression spec imports `test`/`expect` from `helpers/perf-tracking.js` (not `@playwright/test` directly); `helpers/performance-reporter.cjs` (wired into `playwright.config.js`) aggregates each run into day-dated JSON under `testing/performance-testdata/` (gitignored, matches rohas's own convention — confirmed by checking rohas's `.gitignore`). `helpers/perf-aggregate.js` is the pure, unit-tested aggregation + cross-process-lock day-file-append logic.
2. **Load test** — `scripts/run-load-test.js` (`npm run test:load`): N concurrent full-suite OS processes against one shared DB-mode server, seeded once. `playwright.config.load-test.js` is a dedicated config (not the main one) with `reuseExistingServer: true` and no globalSetup, used only by this script's spawned workers.
3. **Throughput test** — `scripts/run-throughput-test.js` (`npm run test:throughput`/`test:throughput:db`): autocannon-based p95/error-rate check against `/health`, `/api/site-config`, `/api/tenants/mine`.

**Deliberately NOT ported from rohas:**
- **DB-time breakdown** — rohas's `req.db` is a fresh per-request query interface in both modes, so wrapping its methods for timing is trivial; amaradata's DB-mode routes call a shared, module-level `db.query()` directly, so there's no per-request hook without introducing `AsyncLocalStorage` into `backend/db.js`. User explicitly chose to skip this — only API round-trip timing is captured, no DB-only figure.
- **Interactive deploy-gate prompt** (`deploy-load-test-gate.js` equivalent) — amaradata's `npm run deploy` is a straight non-interactive `&&` chain; adding a stdin y/n prompt mid-chain is a distinct UX decision not requested. The load/throughput tests exist as standalone npm scripts, not wired into `deploy` or `test:all`.

**Real bugs found and fixed while verifying (in the new test code, not the app):**
- `run-load-test.js`'s default `--duration-ms` (copied as 60000 from rohas) was far too short — amaradata's full regression suite takes ~6 minutes single-process, and Playwright's `--global-timeout` is a hard cutoff that marks the *whole run* as failed if it doesn't finish in time, not a graceful "stop and report partial results." Fixed default to 900000 (15 min) with a comment explaining why the bound must exceed normal single-process runtime.
- Several specs generated test data with raw `Date.now()` (slugs, emails, a tenant `uid`) — fine for one process, but 5 concurrent load-test processes can call `Date.now()` within the same millisecond and collide (409s). Added `uniqueSuffix()`/`testSlug()`/`testEmail()` to `helpers/edit-save.js` (timestamp + random) and swapped every raw `Date.now()`-based identifier over to them.

**Verified for real, not just assumed:** ran the actual regression suite (confirmed real `performance-testdata` written with genuine per-test timing), ran a real 2-concurrent-process slice of the load test against the live `amaradata-platform_test` Postgres DB (both processes' tests passed, both wrote to the same day-file within 145ms of each other with zero data loss — proves the cross-process lock genuinely works under real contention, not just in a mocked unit test), and ran the throughput test for real (3/3 endpoints passed, p95~13ms).
