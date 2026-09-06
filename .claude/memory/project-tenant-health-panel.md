---
name: project-tenant-health-panel
description: System Health page (admin-health.html) now shows per-tenant health via GET /api/admin/tenants-health, not just the portal's own health
metadata:
  type: project
---

Added a "Tenant Health" panel to `frontend/admin-health.html`, backed by a new `GET /api/admin/tenants-health` route in `backend/routes/admin.js` and `backend/services/tenant-health-client.js`. Previously the System Health page (`GET /api/admin/health`) only ever reported AmaraData's *own* health (versions, DB mode, table row counts) — it had no visibility into tenant sites at all.

**How it works:** calls each tenant's own public `GET /health` (every tenant site — confirmed via the sibling `tenant-group` repo's `backend/server.js:344` — exposes this the same public/no-auth way AmaraData's own `server.js:93` does). No API key needed, unlike [[project-billing-commission-computation]]'s `billing-tenant-client.js`, `owner-portal-tenant-client.js`, or `tenant-sso-client.js` — those need a dedicated credential because they call authenticated tenant endpoints; `/health` is deliberately public on every tenant site.

`checkTenantHealth(tenant, opts)` never throws — normalizes every outcome (`reachable`, `status_code`, `latency_ms`, `remote`, `error`) including "no site_url configured" and a 5s timeout via `AbortController`, same per-tenant try/catch contract as `jobs/collect-metrics.js`'s `collectAllTenants` (one down tenant must never take out the whole panel). `fetchImpl` is injectable for testing (same pattern as `tenant-sso-client.js`'s unit tests — `vi.stubGlobal('fetch', ...)`).

Frontend fetches tenant health as a **separate** request from the portal's own health (`loadTenantHealth()`, not part of the original `Promise.all` in `load()`) — a slow/unreachable tenant must never delay or blank out the portal panel that already rendered.

**Test coverage:** unit (`testing/unittests/unit/tenant-health-client.test.js` — mocked fetch, all outcome branches), API/integration DB mode (`src/test/admin-routes.test.js`, stubs global fetch scoped to its own `describe` block), NonDB mode (`src/test/nondb-readonly.test.js` — the seeded no-site_url tenant needs no fetch stub at all, since that branch never calls fetch). No E2E spec — this is a read-only display panel, not an editable/addable record, so it falls outside the [[feedback-testing-pyramid]] edit-save-*.spec.js requirement.

**Why:** user asked "are you showing the health of each tenant?" on the System Health page — answer was no, prompting this addition.
