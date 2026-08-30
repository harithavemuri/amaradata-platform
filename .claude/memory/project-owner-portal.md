---
name: project-owner-portal
description: "AmaraData's side of the cross-tenant owner portal: property_owner role/accounts, owner_portal_uid identity, owner_tenant_links admin screen — Phase B of a three-repo build (see rohas-group's project_owner_portal.md for the full picture)"
metadata:
  type: project
---

**Three-repo system.** This app (amaradata-platform) owns owner *identity*;
`rohas-group` (a tenant) owns owner *data*; `amaradata-ownerportal` (new repo
this cycle, not yet created on GitHub) is the owner-facing app itself, live
at `portal.amaradata.com`. No data is replicated between them — the portal
calls each tenant's own read-only API live. Full cross-repo design lives in
rohas-group's own `project_owner_portal.md` memory; this file covers only
what changed on amaradata-platform's side.

**Identity model:** `property_owner` is a real `amr_roles` row; owner
accounts are literal `amr_users` rows — reused, not a separate table, per
explicit user correction ("Reuse amr_users, why do you need separate
table"). Login on this app rejects `role==='property_owner'` (staff-only);
the portal app enforces the mirror-image guard.

**Owner matching redesign (2026-08-30):** tenant-side email matching was a
real bug — two owners can share an email — so the join key is now an
explicit UID, never email:
- `amr_users.owner_portal_uid` (migration `2026.08.30.001`) — a permanent,
  auto-generated (`crypto.randomUUID()`, app-side — this DB has no pgcrypto)
  cross-tenant identity for a `property_owner` account. Generated
  automatically on `POST /api/admin/users` (role=property_owner) and on
  `PUT /api/admin/users/:id` when a role is *changed* to property_owner —
  never a manually-entered field, never exposed for hand-editing.
- `owner_tenant_links` table — records every (owner account) <-> (one
  tenant's `property_owners` row) mapping staff have made. **Purely
  AmaraData-side bookkeeping/display** — the portal itself never reads this
  table at request time, and which tenants an owner can query at all is
  governed entirely by `group_tenant` (role=property_owner), independent of
  whether a link row exists here. `tenant_owner_email`/`tenant_owner_name`
  are denormalized display fields from the tenant's search response,
  captured at link time and never re-synced.
- `backend/services/owner-portal-tenant-client.js` — new service, calls a
  tenant's `GET /api/owner-portal/search-owners` and
  `PUT /api/owner-portal/link` directly using that tenant's own dedicated
  key (`tenants.owner_portal_api_key`/`_secret_arn`, resolved via
  `services/secrets.js`). **Deliberately not `tenant-sso-client.js`** — that
  file's SSO staff-impersonation flow is for admin actions taken "as" a
  staff member against `/api/admin/*`; this is a separate server-to-server
  credential, matching rohas-group's `service-auth.js` convention of one
  dedicated key per integration (never the billing key).
- New endpoints: `GET /api/tenants/:id/owner-candidates?q=` (tenants.js,
  `requireSuperAdmin`, proxies to the tenant's search), and on admin.js:
  `GET/POST/DELETE /api/admin/users/:id/owner-links` and
  `POST /api/admin/users/:id/rotate-owner-uid` (regenerates the UID and
  re-pushes it to every linked tenant; per-tenant failures are reported
  individually rather than failing the whole rotation; refuses to rotate a
  disabled account).
- **DELETE on a link only removes the AmaraData-side record** — it does NOT
  clear the tenant's `property_owners.owner_portal_identifier`. This is
  intentional: real access is gated by `group_tenant`, so an orphaned
  identifier on the tenant side is harmless bookkeeping drift, not a live
  grant. Don't "fix" this into a cross-tenant clear-on-delete without
  checking with the user first — it would add a write dependency between
  unlink and tenant reachability that doesn't currently exist.
- No admin **frontend** screen built yet for this — API-only so far. Next
  step if picked back up: a page (model it on `frontend/tenants.html`'s
  modules modal) that lets staff pick an owner, pick a tenant, search
  candidates, link, and trigger rotation.

**Test coverage:** `src/test/owner-links-routes.test.js` — UID
auto-generation on create/role-change, the owner-candidates proxy (mocked
`owner-portal-tenant-client.js`, same monkey-patch-the-real-module pattern
`tenant-modules-routes.test.js` uses for `tenant-sso-client.js` — `vi.mock()`
doesn't reliably reach a module nested inside `server.js`'s own CJS require
chain), link CRUD (idempotent upsert, 409-passthrough on a tenant-side
duplicate, 502 on tenant-unreachable), and rotation (per-tenant partial
failure, disabled-account refusal). All three test tiers (DB, NonDB,
`testing/unittests`) pass with this added — 232 + 34 + 453 tests, no
regressions.

**Real pre-existing bug noticed, not fixed (out of scope for this change):**
`database/schema.sql` creates `group_tenant` (references `tenants(id)`) and
ALTERs `tenants` itself *before* `CREATE TABLE IF NOT EXISTS tenants` — only
harmless today because this file has never actually been run against a truly
fresh (never-migrated) database; every real environment already has
`tenants`. Flag if a fresh-DB bootstrap is ever attempted from this file
as-is — it will fail on `group_tenant`'s `REFERENCES tenants(id)`.
