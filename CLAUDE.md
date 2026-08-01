# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AmaraData Platform — Developer Guide

### Setup

```bash
npm install
cp .env.example .env        # fill in DB credentials and JWT secret
psql -U postgres -d amaradata_platform -f database/schema.sql
npm run dev
# → http://localhost:9000
```

### NonDB mode (no database required)

```bash
cp .env.nondb.example .env
npm run dev:nondb
# or: NONDB_MODE=true npm start
```

Data lives in `transactiondata/*.json`. Seed from a live DB at any time:

```bash
npm run export-db              # all tables
npm run export-db tenants,invoices  # specific tables
```

### CLI

```bash
node scripts/cli.js export-db [tables]   # DB → JSON files
node scripts/cli.js serve-nondb          # start in file-based mode
node scripts/cli.js check-db             # test DB connectivity
node scripts/cli.js stats                # row counts per table
node scripts/cli.js sync [--dry-run]     # JSON files → DB
```

### Testing

**Rule: DB-mode tests always run before NonDB-mode tests, in every suite that has both.** Never reorder this — it's a standing, permanent rule, not a per-command preference.

```bash
npm test                                    # 3 suites in sequence: DB mode, NonDB mode, unittests
npm run test:db                             # src/test/*, real Postgres (DB name must end in _test)
npm run test:nondb                          # src/test/*, file-based mode
npm run test:unittests                      # testing/unittests/{api,integration,ui,unit}
npm run test:regression                     # Playwright, NonDB mode (default)
npm run test:regression:db                  # Playwright, real DB mode
npm run test:regression:all                 # DB mode first, then NonDB
npm run test:release-tracking               # Playwright release checks, local by default (see below)
npm run smoke                               # scripts/smoke-prod.js — read-only checks against a live URL
npm run test:all                            # everything above, DB-mode-first throughout
npm run test:watch                          # watch mode
npx vitest run src/test/auth-routes.test.js # run a single test file
```

Tests use Vitest + jsdom + supertest. Setup: `src/test/setup.js` (sets `NONDB_MODE=true`).

Five test layers, mirroring rohas-group's structure:
1. **Unit** — `testing/unittests/unit/` — pure logic, no HTTP/DB/filesystem beyond a throwaway temp dir (token sign/verify, `FileDbService`, CSV parsing in `jobs/sync-tenant-fixes.js`).
2. **API/integration** — `src/test/*.test.js` (route tests, run once against DB and once against NonDB) and `testing/unittests/{api,integration}` (its own `vitest.config.js`, DB mode only).
3. **Playwright regression** — `testing/regression_testsuite/`, full UI flows against a locally-started server.
4. **Release-tracking** — `testing/release-tracking/checks/TC-*.spec.js`, one check per historically-fixed issue (see below).
5. **Smoke** — `scripts/smoke-prod.js`, read-only API checks against a live URL (`SMOKE_URL`, defaults to production).

Follow the unit > integration > E2E > smoke pyramid — place new tests at the lowest layer that can exercise the behavior.

**Critical test rule:** Every `/api/*` response must carry `Content-Type: application/json` — never HTML. This guards against a CloudFront CustomErrorResponses bug where errors were served as HTML instead of JSON.

**Test DB failsafe:** `src/test/global-setup.js` calls `assertTestDb()` — if the DB name doesn't end with `_test`, the suite aborts. All 14 tables are TRUNCATEd (cascade) at suite start.

**Regression tests (Playwright):** Lives in `testing/regression_testsuite/`. Runs against port 9001 (not 9000). Defaults to NonDB mode; set `REGRESSION_DB=1` to use a real DB (`npm run test:regression:all` / `npm run deploy` run DB mode first, then NonDB).

**Release-tracking checks (Playwright):** Lives in `testing/release-tracking/checks/`, one `TC-<n>-*.spec.js` per historically-fixed, verified issue — see `release-test-map.json` for the index. By default these spin up their own isolated local NonDB server (port 9002, `testing/release-tracking/server-entry.js` + `global-setup.js`) so they're safe to run without prod credentials or touching real data. Set `PW_BASE_URL` to point a run at a real deployed environment instead — in that mode auth comes from `SMOKE_TEST_USER`/`SMOKE_TEST_ADMIN_PASSWORD` (same convention as `scripts/smoke-prod.js`) and no local server is started. New checks: prefix any data they create with `zzzzzz` (`feedback-test-data-prefix`) and delete it in `afterEach` via `DELETE /api/enhancements/:id` (or the relevant route) — the prefix is a safety net, not a substitute for cleanup.

**E2E edit/save coverage (permanent requirement):** Every editable/addable admin screen must have an `edit-save-<screen>.spec.js` in `testing/regression_testsuite/` that (1) creates/edits through the real UI, (2) verifies persistence via an API readback (`testing/regression_testsuite/helpers/edit-save.js`'s `apiGet`/`apiPost`/`apiPut`/`apiPatch`) — not just a DOM toast/row check, (3) cleans up in `afterEach` via `apiDelete` where a DELETE route exists, and documents why not where it doesn't (`tenants`, `invoices`, `billing_metrics` have no DELETE route — suite-level DB truncation at `global-setup.js` covers it instead, since these run only once per whole `npx playwright test` invocation, not per file). Screens covered: `tenants` (`tenants.spec.js`; its zero-tenant "empty state" checks live separately in `00-tenants-empty-state.spec.js` — numeric prefix is deliberate, so it always runs first, before any other file's tenant-creating tests can pollute a check that needs a genuinely empty table), `enhancements`, `roles` (role `name` must match `/^[a-z_]+$/` — use `helpers/edit-save.js`'s `randomRoleName()`, not a `Date.now()`-based name), `user-groups` (incl. member/tenant sub-resources — `amr_roles` starts empty in a fresh test DB, so the tenant-assignment sub-test creates its own role rather than assuming one exists), `users`, `invoices` (add-save + status-transition, no PUT route exists), `metrics` (upsert-style: same tenant+period submitted twice is the "edit" path). `email.html` is excluded from this pattern specifically for its send/reply actions (not a persisted-and-later-edited record), but folders *are* such a record, so `email.spec.js`'s `Email — folders` describe block follows the same create→API-readback convention inline rather than in a separate `edit-save-email.spec.js` file — see "Email page testing" below. Add a new spec here whenever a new editable screen ships. **Gotcha:** NonDB mode stores IDs pulled from a DOM `<select>` as raw strings — compare with `==`, not `===`, when matching a numeric id/tenant_id against an API readback result (same reason `FileDbService.find()` uses `==` internally).

**Filter/search (read) coverage:** `edit-save-enhancements.spec.js` (status/source/type filters), `edit-save-invoices.spec.js` (status filter), and `edit-save-users.spec.js` (name/email search box, client-side) cover the read/narrow-existing-data behavior that plain add/edit-with-readback doesn't exercise. **Gotcha:** if a filter/search test needs a *different* logged-in user than the file's main `describe`, it must be its own top-level `test.describe`, never nested inside one that already logs in — nested `beforeEach` hooks all run against the *same* `page` for one test, and `login.html` auto-redirects to `/dashboard` whenever already logged in, so a second `loginAs()` call's `#username` field never renders (reproduced: all 3 of `edit-save-enhancements.spec.js`'s original filter tests timed out this way before the fix). See `Enhancements — filters`'s separate top-level describe for the pattern to follow.

**Accessibility + responsive coverage:** `testing/regression_testsuite/accessibility.spec.js` runs `@axe-core/playwright` against the public homepage (`/`) and `/login` (the pages that matter most for compliance/SEO — not every admin screen), plus a horizontal-overflow check at mobile/tablet/desktop viewport widths (375/768/1440px). Extend the `PAGES` array here if a specific admin page needs the same coverage. **Gotcha:** small bold uppercase "eyebrow" label text (`.eyebrow`, `.contact-item h3`, footer links) at the brand blue `#008cbb` fails WCAG AA contrast at that size/weight on both white and the dark `#112240` navy background — axe caught this — use `#006d96` (darker) on light backgrounds and `#3fb8e8` (lighter) on dark ones for small text; `#008cbb` itself is reserved for larger UI (buttons, headings, icons) where it does pass.

**Role/permission coverage:** `testing/unittests/unit/role-guards.test.js` — exhaustive matrix (every guard × every one of the 5 roles, mocked req/res, no HTTP). `testing/unittests/api/role-guards-routes.test.js` — one representative real-Express route per guard tier, catches guard-wiring mistakes the pure-unit matrix can't. `testing/regression_testsuite/role-login-smoke.spec.js` — E2E login + dashboard-render check for `site_admin`/`sales_manager`/`billing`/`staff` (admin's is already covered by `login-dashboard.spec.js`). `sales_manager` and `billing` currently render an identical nav to `admin` — that's a real frontend gap, not a test gap; the smoke spec's coverage for those two roles is intentionally thin until the UI differentiates them. Seeded per-role users live in `testing/regression_testsuite/helpers/seed-users.js`, seeded by `global-setup.js`.

**Performance SLA:** API ≤500ms, page load ≤3s (`feedback-performance-sla.md`). `testing/unittests/integration/performance.test.js` times one representative request per route file (already DB-mode only — `testing/unittests/` has no NonDB config); `login-dashboard.spec.js`'s "dashboard loads within the 3s page-load SLA" test uses the Navigation Timing API and is explicitly `test.skip`'d unless `REGRESSION_DB=1` — NonDB's file-based reads are artificially fast and wouldn't catch a real regression.

**Performance benchmark history:** every `testing/regression_testsuite/*.spec.js` run captures per-test API-call timing automatically — specs import `test`/`expect` from `./helpers/perf-tracking.js` instead of `@playwright/test` directly, and `./helpers/performance-reporter.cjs` (wired into `playwright.config.js`'s `reporter` array) aggregates each run into a day-dated JSON file under `testing/performance-testdata/` (gitignored, local-only — matches rohas-group's own convention). No DB-time breakdown: amaradata's DB-mode routes call a shared, module-level `db.query()` rather than a per-request query interface, so unlike rohas there's no cheap hook to attribute DB time to a specific request; only round-trip API timing is captured. `helpers/perf-aggregate.js` holds the pure aggregation/day-file-append logic (unit-tested, with a cross-process file lock — needed because the load test below runs several OS processes writing to the same day file at once).

Each run's `mode` field is one of three values, resolved by `helpers/perf-aggregate.js`'s `resolveReporterMode(dbModeEnabled, testDbName)` — never a bare boolean flag: **`nondb`** (file-based), **`regressiondb`** (DB mode, and the target database name ends in `_test` — the only reachable DB-mode case today, since `global-setup.js` refuses to run against anything else), or **`db`** (DB mode against a database that is *not* `_test`-suffixed — not reachable through this suite's normal safety-guarded flow, but labeled honestly rather than silently folded into `regressiondb` if that guard is ever bypassed). Don't reintroduce a plain `mode: DB_MODE ? 'db' : 'nondb'` ternary in either `playwright.config.js` or `playwright.config.load-test.js` — both must go through `resolveReporterMode`.

**Load test** (`npm run test:load` → `scripts/run-load-test.js`): N concurrent full Playwright-suite OS processes (default 5, `--users`) against one shared DB-mode server, proving concurrency doesn't corrupt shared data. Seeding happens exactly once, before any worker spawns (not once per process — see `playwright.config.load-test.js`'s header comment). Data-collision avoidance is via `helpers/edit-save.js`'s `uniqueSuffix()`/`testTag()`/`testSlug()`/`testEmail()` (timestamp + random), not per-worker row assignment. `--duration-ms` (default 15 min) is a hard Playwright `--global-timeout` — it must comfortably exceed the suite's normal single-process runtime (~6 min as of this writing) or the whole run gets marked failed/timed-out even though nothing actually broke. Requires the `amaradata-platform_test` Postgres DB.

**Throughput test** (`npm run test:throughput` / `test:throughput:db` → `scripts/run-throughput-test.js`): autocannon-based latency/error-rate check against `/health`, `/api/site-config`, and `/api/tenants/mine` (all safe under high concurrency — amaradata has no per-tenant DB-routing complexity to worry about here, unlike rohas-group). Fails on p95 (autocannon's `p97_5`) exceeding 500ms or any error/non-2xx/timeout. `helpers/throughput-runner.js` holds the pure evaluation logic (unit-tested).

Neither the load test nor the throughput test is wired into `npm run deploy` or `test:all` — they're slower, heavier, and optional; run manually or add to CI as a separate gate if desired. rohas-group gates its equivalent load test behind an interactive deploy-time prompt (`scripts/deploy-load-test-gate.js`) — amaradata deliberately doesn't replicate that, since `npm run deploy` here is a straight non-interactive `&&` chain and adding a stdin prompt mid-chain is a distinct UX decision that hasn't been made.

### Deployment (AWS SAM)

Always deploy via `npm run deploy` — it gates on tests passing before building and deploying:

```bash
npm run deploy                              # unit/integration → regression(DB→NonDB) → release-tracking → tag → sam build/deploy → S3 sync → CF invalidate → post-deploy smoke
sam build && sam deploy --config-env staging  # staging only
```

Never run `sam deploy` directly; the `npm run deploy` test gate is mandatory.

**Release tagging:** `scripts/tag-release.js` creates and pushes an annotated `vX.Y.Z` git tag (matching `package.json`'s `version`) before `sam build` — no-ops if the tag already exists (bump `version` for a new release).

**Post-deploy smoke:** `npm run smoke:lifecycle` runs automatically at the end of `npm run deploy` — it enables the smoke-test account (`PUT /api/admin/users/:id` via a bootstrap `site_admin` account, see `.env.test.example`), runs `scripts/smoke-prod.js`, then disables the account again in a `finally` regardless of outcome, and verifies the disabled account can no longer log in. Credentials come from `.env.test` (gitignored, copy from `.env.test.example`) — never share the account between phase 1 (deploy gate) and phase 2 (this) without re-authenticating, since the bootstrap admin's JWT is short-lived (15 min).

Secrets live in AWS Secrets Manager at `/<tenant>/<env>/<name>`:
- `jwt-secret`, `google-client-secret`, `origin-secret`
- `db-host`, `db-write-user`, `db-write-password`, `db-read-user`, `db-read-password`

Config (non-secret) lives in SSM Parameter Store: `google-client-id`, `db-host` (redundant), DB usernames.

### Infrastructure constraints

See `.project-constraints` — serverless-only (Lambda + API Gateway). No EC2, Docker, or containers. RDS/Aurora must never be publicly accessible; Lambda must reach the DB via VPC.

### Spec-driven development

`specs/constitution.md` is the binding rule set (code quality, security, data layer, frontend, testing, deployment) — most of it is mirrored into this file, but check it directly when in doubt. `specs/sso-architecture.md` documents the cross-tenant SSO design (see below).

---

## Architecture

### Overview

Single Node/Express server (`server.js`, port 9000) serving both a REST API (`/api/*`) and static HTML frontend (`/frontend`). A GraphQL endpoint lives at `POST /graphql` (auth-gated). Unmatched routes fall back to `login.html`.

### Key files

| Purpose | Path |
|---------|------|
| Server entry point | `server.js` |
| PostgreSQL pool (dual read/write) | `backend/db.js` |
| NonDB mode middleware | `backend/middleware/nondb-mode.js` |
| Auth middleware (JWT) | `backend/middleware/auth.js` |
| File-based DB service | `backend/services/file-db-service.js` |
| Email (AWS SES) | `backend/services/ses.js` |
| Email inbox/compose/reply S3 client (isolated for test mocking) | `backend/services/email-s3-client.js` |
| Google OAuth (PKCE) | `backend/auth/google-auth.js` |
| GraphQL schema + resolvers | `backend/graphql/` |
| Frontend shared utilities | `frontend/js/platform.js` |
| DB schema | `database/schema.sql` |
| Table manifest for NonDB | `metadata/manifest.json` |
| AWS SAM template | `template.yaml` |
| Development constitution | `specs/constitution.md` |
| SSO architecture (AmaraData ↔ tenant sites) | `specs/sso-architecture.md` |
| Scheduled billing-metrics job | `jobs/collect-metrics.js` |
| DB → JSON export job (backs `npm run export-db`) | `jobs/export-db-to-files.js` |
| Tenant fix/enhancement sync job (backs `npm run sync-tenant-fixes`) | `jobs/sync-tenant-fixes.js` |
| Target-aware enhancements seed wrapper (backs `npm run seed:local` / `seed:production`) | `scripts/seed-enhancements.js` |
| Git tag-before-deploy | `scripts/tag-release.js` |
| Smoke-account enable/disable lifecycle | `scripts/smoke-lifecycle.js` |
| Smoke/release-check credential template | `.env.test.example` (copy to `.env.test`, gitignored) |
| Shared edit-save Playwright helpers | `testing/regression_testsuite/helpers/edit-save.js` |
| Performance-benchmark fixture + reporter | `testing/regression_testsuite/helpers/perf-tracking.js`, `performance-reporter.cjs`, `perf-aggregate.js` |
| Concurrent-user load test (backs `npm run test:load`) | `scripts/run-load-test.js`, `playwright.config.load-test.js` |
| Throughput/latency test (backs `npm run test:throughput`) | `scripts/run-throughput-test.js` |
| Seeded per-role Playwright users | `testing/regression_testsuite/helpers/seed-users.js` |

### Route structure

| Prefix | File | Auth required |
|--------|------|--------------|
| `/api/auth` | `backend/routes/auth.js` | Login/create-user are public; all others `requireAuth` |
| `/api/admin` | `backend/routes/admin.js` | `requireSiteAdmin` (whole router, via `router.use`) |
| `/api/tenants` | `backend/routes/tenants.js` | `requireAuth` |
| `/api/subscriptions` | `backend/routes/subscriptions.js` | `requireAuth` |
| `/api/invoices` | `backend/routes/invoices.js` | `requireAuth` |
| `/api/enhancements` | `backend/routes/enhancements.js` | `requireAuth` |
| `/api/metrics` | `backend/routes/metrics.js` | `requireAuth` |
| `/api/email` | `backend/routes/email.js` | `requireAuth` + `requireAdmin` per-route (inbox/send/reply via SES + S3; per-user folders/Trash/thread/download via `email_folders`/`email_placements`) |
| `/api/contact` | `backend/routes/contact.js` | Public |
| `/api/site-config` | inline in `server.js` | Public |
| `/health` | inline in `server.js` | Public |
| `POST /graphql` | `backend/graphql/` | `requireAuth` |

### Dual-mode data layer (mandatory)

Every route must support both PostgreSQL and file-based (NonDB) mode. Check `req.db.mode` at the top of each handler:

```js
if (req.db.mode === 'nondb') {
    // use req.db.fileDb (FileDbService) — methods: find, getById, create, update, delete, count
} else {
    // use db (the imported pg pool wrapper) — db.query() auto-routes SELECT→read pool, writes→write pool
}
```

`backend/db.js` maintains separate write (max 10) and read (max 10) pools; `query()` inspects the SQL verb to route automatically (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/TRUNCATE → write pool; everything else → read pool).

When adding a new DB table:
1. Add `CREATE TABLE` to `database/schema.sql`
2. Add `metadata/<table>.schema.json`
3. Add `transactiondata/<table>.json` (empty array `[]`)
4. Add table name to `metadata/manifest.json`
5. Add NonDB branch to all route handlers for the new table

### API conventions

- **Versioning:** `Accept: application/json;v=1` header — never in the URL path
- **Auth:** `Authorization: Bearer <token>` — 15-min access tokens, 1-hr refresh tokens
- **Responses:** `{ success: true, data: ... }` for success, `{ error: "..." }` for errors
- **Origin protection:** `X-Origin-Secret` header (set via `ORIGIN_SECRET`) blocks direct API Gateway hits; `/health` and `/api/site-config` are exempt

### Auth & roles

`backend/middleware/auth.js` exports three guards:
- `requireAuth` — any valid JWT; attaches `req.staff` with `{ id, email, name, role, type }`
- `requireAdmin` — role must be `admin` or `site_admin`
- `requireSiteAdmin` — role must be `site_admin` only

Roles defined in `amr_roles`: `site_admin`, `admin`, `sales_manager`, `billing`, `staff`.

`POST /api/auth/create-user` is the first-time setup endpoint and requires `setup_key = AMRD_JWT_SECRET` in the body instead of a Bearer token.

`POST /api/auth/login` takes `{ username, password }` — **not** `email` — matched case-insensitively (`lower(username) = lower($1)`). Email is a separate, non-unique field (shared emails across users are allowed); `create-user` still requires an email but login never uses it.

### Auth flow (frontend)

- Login stores `amrd_token`, `amrd_refresh_token`, `amrd_staff` (JSON) in localStorage
- `platform.js` `apiFetch()` automatically refreshes the access token on 401 then retries
- 401/403 responses show an access-denied modal with a 10-second countdown, then redirect to `/login`
- 15-minute inactivity timeout is started automatically by `renderSidebar()` in `frontend/js/platform.js`; all protected pages call this — no extra work needed
- `POST /api/auth/create-user` requires `setup_key = AMRD_JWT_SECRET` (first-time setup only)

### Cross-tenant SSO

AmaraData is the **SSO issuer** for tenant sites (e.g. rohas-group): `POST /api/auth/sso/issue` mints a 60-second HMAC-signed JWT (`SSO_SECRET`, shared via Secrets Manager at `/shared/<env>/sso-secret`) that a tenant site exchanges for its own session JWT. Full flow, token shape, and steps for onboarding a new tenant are in `specs/sso-architecture.md`.

### Tenant fix/enhancement sync

Each tenant repo (sibling directory of amaradata-platform, e.g. `rohas-group`) tracks its bug fixes and enhancement work in `testing/release-tracking/*.csv` (columns: `IssueId, Report Date, Notes, Site Name, Tenant Name, Apply Fix?, Fixed?, Fix Details, Type, Billable`, optionally `Test After Release`/`TestId`). `jobs/sync-tenant-fixes.js` (`npm run sync-tenant-fixes`) scans every sibling folder for this file, upserts rows where `Apply Fix? = Yes` into the `enhancements` table (keyed on `tenant_id` + `issue_id`, matching `POST /api/enhancements/import`'s semantics), and is wired into `.git/hooks/pre-commit` as a non-blocking step after `npm test`. `Type=Task` is always normalized to `enhancement`; `Billable` is trusted as the explicit per-row override — bugs default non-billable, enhancements default billable, unless the sheet says otherwise.

`scripts/seed-enhancements.js` (`npm run seed:local` / `seed:production`) wraps the same job with an explicit `--target`, mirroring rohas-group's `apply-local-migrations.py` pattern of a single script that names its destination rather than relying on whatever `.env` happens to be loaded:
- **`--target=local`**: runs `jobs/sync-tenant-fixes.js` directly against the local (non-`_test`) Postgres DB via `.env`'s `AMRD_DB_*` creds — a real DB write, safe to re-run (upsert).
- **`--target=production`**: RDS is VPC-only and never publicly reachable from a local machine (see `.project-constraints`), so this can never open a direct prod DB connection. Instead it regenerates `transactiondata/enhancements.json` locally, then — only with `--yes` — calls the already-deployed `POST /api/admin/sync-to-db` (same mechanism as the admin UI's "Sync to DB" button, auth via `SMOKE_BOOTSTRAP_ADMIN_USER`/`PASSWORD` in `.env.test`) to pull that data into the live DB. That endpoint reads the *deployed* server's own bundled JSON, so the regenerated file must be committed and deployed first — running with `--yes` before that is a no-op, not an error.

### Frontend

Static HTML pages in `frontend/`. Shared logic is in `frontend/js/platform.js`, which provides:
- `apiFetch(url, options)` — auth-aware fetch with auto token refresh and 401/403 modal
- `gqlFetch(query, variables)` — GraphQL helper
- `renderSidebar(config)` — builds navigation, starts session timeout, shows NonDB mode badge
- CSS injection for the admin UI (dark sidebar, cards, tables, modals)

The NonDB mode indicator (yellow badge) is injected by `renderSidebar` when the server sets the `X-DB-Mode: nondb` response header.

### Email (SES)

`backend/services/ses.js` sends via AWS SES. When `SES_FROM_EMAIL` is not set (local dev), it logs to stdout instead of sending. Requires IAM `ses:SendEmail` permission on the verified `amaradata.com` identity.

`backend/routes/email.js` (the inbox/compose/reply UI's backend) is a separate code path with its own `sendRaw()` helper — same `SES_FROM_EMAIL`-unset-means-dev-mode convention as `ses.js`, added after `/send`/`/:id/reply` were found calling SES unconditionally with no guard at all (same class of gap `contact.js`'s `sendAdminEmail()` had before it was fixed — see git history). S3 access (`s3`, `ListObjectsV2Command`, `GetObjectCommand`) is isolated into `backend/services/email-s3-client.js` specifically so it's mockable in tests — `vi.mock()` does not reliably intercept `require()` calls nested inside `server.js`'s own CJS require graph (confirmed: the mock factory silently never runs), so `src/test/email-routes.test.js` instead uses `createRequire(import.meta.url)` to reach the exact same object `email.js`'s `require()` sees (the same pattern `src/test/setup.js`'s `afterAll` already uses for `db.js`'s pools) and overwrites `.send` directly. `EMAIL_BUCKET` is set in both `setup.js`/`setup.nondb.js` so the route logic actually runs instead of short-circuiting on the 503 guard.

**Email page testing:** `src/test/email-routes.test.js` covers `/api/email/*` (auth guards, inbox parsing/sort order, attachment download, 400/404/500 paths, send/reply, and the folders/move/trash/download/thread routes below) with the S3 client stubbed as above — SES calls are never mocked since dev-mode already no-ops them. `testing/regression_testsuite/email.spec.js` covers the UI: page load, the real EMAIL_BUCKET-not-configured error state (accurate for this suite's server, which never sets it), compose modal open/cancel, client-visible validation-failure alert, a full compose→send→modal-closes happy path (safe because of `sendRaw()`'s dev-mode guard), and a `Email — folders` describe block with real create/switch/delete/duplicate-name UI flows verified via API readback (`helpers/edit-save.js`, same convention as the `edit-save-*.spec.js` files — folders are a real persisted record, unlike send/reply). Reply, move/trash/permanent-delete, download, and thread aren't covered at the E2E layer — those need `EMAIL_BUCKET` pointed at a real bucket, which no test tier in this repo sets up; they're covered instead at the API/integration layer in `email-routes.test.js` with S3 mocked.

**Per-user email folders, Trash, and message-chain download:** Emails themselves are never stored in a DB table — they live in S3 and are read via `mailparser`. Per-user organization (folders, Trash) is layered on top via two DB/NonDB-dual-mode tables: `email_folders` (`user_id`, `name`, `is_trash`, `UNIQUE(user_id, name)`) and `email_placements` (`user_id`, `email_id` — the S3 key — `folder_id`, `UNIQUE(user_id, email_id)`). **Inbox is implicit, not a row**: an email with no `email_placements` row for a user shows in that user's Inbox by default; only an explicit move (including to Trash) creates a placement row. Trash is a real folder row (`is_trash=true`) but is created lazily on first use (`getOrCreateTrash()` in `email.js`), not seeded per-user up front — same reasoning as not seeding an Inbox row.

- `GET/POST /api/email/folders`, `DELETE /api/email/folders/:id` — per-user folder CRUD; deleting a folder reassigns its emails back to Inbox (`ON DELETE SET NULL` in DB mode, explicit placement-row deletion in NonDB mode); the Trash folder can't be deleted.
- `PUT /api/email/:id/move` `{ folder_id: null|<id> }` — moves an email into a folder, or back to Inbox when `folder_id` is `null`. Also used for "restore from Trash."
- `DELETE /api/email/:id` — moves to Trash (recoverable via the move route above). `DELETE /api/email/:id/permanent` — actually deletes the S3 object; requires the email to already be in the caller's Trash first (the "permanent delete is a separate, deliberate action" requirement), and cleans up placement rows for every user that had one, not just the caller, since the object is genuinely gone.
- `GET /api/email/:id/download` — raw `.eml` for one message. `GET /api/email/:id/thread` — related message ids found by walking `Message-ID`/`In-Reply-To`/`References` headers transitively across the whole inbox (O(n) scan — fine at small-admin-inbox scale). `GET /api/email/thread/download?ids=a,b,c` — zip of selected messages' raw `.eml` content, built with `archiver`.
- **Route registration order matters**: `/folders`, `/thread/download`, and `/inbox` are registered before the generic `/:id` handlers in `email.js`, otherwise Express would match e.g. `GET /api/email/folders` against `/:id` (treating `"folders"` as an email id) or `GET /api/email/thread/download` against `/:id/download` (id=`"thread"`).
- **`archiver@8` breaking change**: the package dropped its classic `archiver('zip', opts)` factory function in favor of exporting format classes directly — use `new (require('archiver').ZipArchive)(opts)`, not the old factory call (which throws `archiver is not a function` at runtime, not at require time).
- **Frontend downloads need a Bearer header, so plain `<a href>` doesn't work**: this app has no cookie-based session, only a `localStorage` JWT attached by `apiFetch()`'s `fetch()` call — a native browser navigation via `<a href>` never sends it. `frontend/email.html`'s `downloadFile()` helper instead fetches as a blob with the header attached manually and triggers the save via a throwaway `URL.createObjectURL` anchor. This also fixed the pre-existing attachment-download links, which were plain hrefs before this feature and would have 401'd if actually clicked.

### Serverless deployment

`template.yaml` defines three Lambda functions — only these are wired to real triggers; other files under `backend/lambda/` (`auth-login.js`, `auth-logout.js`, `auth-refresh.js`) are legacy standalone handlers not referenced by any resource and should not be treated as live code paths:
- **`ApiFn`** (`backend/lambda/api.js`): 1 GB memory, 29 s timeout; wraps the whole Express app via `serverless-http`; handles `/api/{proxy+}`, `/graphql`, and `/health` behind HTTP API Gateway (not REST API) with basePath routing — the handler strips the stage-name prefix
- **`DBInitFn`** (`backend/lambda/db-init.js`): CloudFormation custom resource, only runs when `CreateDbCluster=true` (dedicated Aurora cluster instead of the shared one)
- **`DBMigrateFn`** (`backend/lambda/db-migrate.js`): invoked explicitly by `npm run deploy` after every `sam deploy` (not a CF custom resource, so it always runs regardless of changeset)
- **Frontend**: S3 bucket behind CloudFront; CloudFront Function rewrites extensionless URLs to `.html`; Origin Access Control (OAC) restricts S3 access to CloudFront only
- **Logs**: one CloudWatch Log Group per tenant/env (e.g., `amaradata-prod`)
- **Cost tags**: all resources tagged `tenant`, `application`, `project`, `component`
- **Shared Aurora cluster**: by default (`CreateDbCluster=false`) this stack reuses the same Aurora cluster as the sibling `rohas-group` tenant stack (same VPC/subnets), just a different database (`amaradata_platform`)
- **Email forwarder** (`email/` — separate SAM app, deploy with `cd email && sam build && sam deploy` before the main stack): SES inbound → S3 → Lambda forwards `rajas@amaradata.com` mail to Gmail; the main stack's `ApiFn` reads/sends from the same S3 bucket (`EMAIL_BUCKET`) for the `/api/email` inbox UI
