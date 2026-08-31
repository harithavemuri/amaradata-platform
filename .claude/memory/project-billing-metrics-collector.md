---
name: project-billing-metrics-collector
description: "jobs/collect-metrics.js rewritten 2026-08-30 to call each tenant's own GET /api/billing/metrics instead of connecting directly to the tenant's Postgres — the old version was broken three ways and never had real production credentials"
metadata:
  type: project
---

**Found 2026-08-30 (user asked "check if the established billing is wired to
Amaradata.com for getting info from tenant DBs"):** `jobs/collect-metrics.js`
looked fully built — real DB queries, real upsert logic — but was never
actually functional:
- Every `billing_metrics` row and both invoices in production matched
  `database/seed_rohas.sql`'s hardcoded values byte-for-byte. Nothing had
  ever been collected for real.
- No cron/EventBridge trigger existed anywhere — pure manual script, never
  run in practice.
- Even run manually it would fail: the real rohas `tenants` row never had
  `tenant_db_user`/`tenant_db_secret_arn` populated (only host/name were
  set); it connected to `amaradata_rohas` (rohas-group's main/shared DB)
  instead of looping the per-project DBs (`rohas_amaracasa` etc.) where
  `properties`/`rent_payments` actually live; and it queried
  `rent_payments.payment_date` (real column: `paid_date`) and
  `properties.sale_price` (doesn't exist).
- It also opened a raw `pg.Pool` directly into rohas's database — the same
  no-direct-cross-DB-reads rule already followed elsewhere (owner-portal,
  billing/project-modules both go through the tenant's own
  service-authenticated API instead; see rohas-group's own
  `feedback_no_direct_cross_db_reads` memory for the rule itself).

**Fix:** `jobs/collect-metrics.js` now calls `backend/services/
billing-tenant-client.js`'s `fetchMetrics(tenant, year, month)` — a real
HTTP call to the tenant's own `GET /api/billing/metrics`, authenticated with
`X-Amaradata-Api-Key` using the tenant's dedicated `billing_api_key`/
`billing_api_key_secret_arn` (migration `2026.08.30.002`), resolved via
`services/secrets.js`. Same shape as `owner-portal-tenant-client.js` —
**deliberately a separate credential**, not shared with the owner-portal
integration (least-privilege: one leaked key can't reach the other). The job
itself is now a thin loop: fetch each active tenant's numbers, upsert into
`billing_metrics`. Refactored to `if (require.main === module) { run() }` +
`module.exports = { collectForTenant, run }` (matching
`jobs/sync-tenant-fixes.js`'s convention) so `collectForTenant` is directly
testable — it never was before, since importing the old file executed it
immediately.

**Real gap found while wiring this: `AMARADATA_API_KEY`/`AMARADATA_API_KEY_ID`
had never actually been added to rohas-group's `template.yaml` at all** —
`serviceAuthMiddleware` and the whole billing route file existed and were
documented, but the env var wiring the CLAUDE.md docs described was never
written. Confirmed live: `GET /api/billing/project-modules` 401ed with
*any* key value in production, before this. Fixed on rohas-group's side the
same day (its own memory has the details); a fresh key was generated and
stored at `/rohas/prod/amaradata-billing-api-key` in Secrets Manager, then
copied into this tenant's `tenants.billing_api_key` here.

**Test coverage:** `src/test/collect-metrics-job.test.js` — mocks
`billing-tenant-client.fetchMetrics` (same monkey-patch-the-real-module
pattern as `owner-links-routes.test.js`), asserts the upsert (not
duplicate-insert) on re-run for the same period, and that a
`tenantUnreachable` failure from one tenant propagates from
`collectForTenant` itself (isolation across tenants happens in `run()`'s
per-tenant try/catch in the loop, not inside `collectForTenant`).

**Not yet decided:** whether to drop `tenants.tenant_db_host/port/name/user/
secret_arn/password` — they're now genuinely dead (this job was their only
consumer) but removing columns is a separate, more deliberate decision than
swapping which mechanism the job uses. Left in place for now.

**"Collect Metrics Now" button + job history (2026-08-30, same session,
api_version 1.3.11):** the job was still manual-only with no UI trigger and
no run history. Added:
- `billing_metrics_job_runs` table (migration `2026.08.30.003`) —
  `period_year/month`, `triggered_by` (NULL = automatic/cron, not built
  yet), `status` (`running|success|partial_failure|failed`), `results`
  JSONB (the exact per-tenant array `collectAllTenants()` already returns —
  persisted as-is, never re-derived).
- `collect-metrics.js` gained `collectAllTenants(year, month)` — the same
  loop `run()`'s CLI used inline, extracted so it never calls
  `process.exit()` and is safe to call from a long-lived Express request.
- `POST /api/admin/billing/collect-metrics` (admin.js, `requireSuperAdmin`
  via the file's existing `router.use`) — runs synchronously (one HTTP call
  per tenant today), inserts a `running` row first, then updates it to its
  final status. A `collectAllTenants` throw (not just a per-tenant failure)
  still marks the row `failed` rather than leaving it stuck at `running` —
  covered by its own test.
- `GET /api/admin/billing/job-runs` — last 100 runs, joined to
  `amr_users` for who triggered them.
- `frontend/metrics.html` — button + a "Job History" modal, both gated
  `window.__amrd.getStaff()?.role === 'super_admin'` (matches
  `tenants.html`'s modules-column idiom exactly). Collects for whatever
  period the page's own Year/Month search fields are currently set to —
  no separate prompt, since the table already shows that exact period.

**Verified against the live dev server, not just unit tests** (no browser
automation tool available, so this was curl-driven, not a real click-through
— flagged honestly rather than claimed as full UI verification): logged in
as a throwaway `zzzzzz.uitest` super_admin, called the new endpoints
directly. First call correctly failed (`"Billing API key not configured for
this tenant"`) since local dev's `tenants` row had no `billing_api_key` set;
after setting it to the same real production key, a second call
successfully pulled live data from `https://rohas.amaradata.com` end-to-end
and the resulting row showed up via both `/api/admin/billing/job-runs` and
the existing `/api/metrics`. Local dev's `tenants` row for rohas was left
pointed at the real production billing endpoint afterward (read-only,
harmless, and useful for testing this feature locally again later) — only
the throwaway user and the job-run/metrics rows it created were cleaned up.

**Gotcha hit setting up the local test user:** a bcrypt hash passed inline
to `psql -c "..."` in PowerShell got silently mangled — PowerShell expands
`$2a`, `$12` etc. as variable references inside a **double**-quoted
`-c` string, truncating the hash to just its literal tail. Fixed by using a
**single**-quoted PowerShell string (which doesn't interpolate `$vars`) with
SQL's own `''`-escaping for the inner single quotes.
