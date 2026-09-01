---
name: project-billing-contact-routing
description: "billing_contacts + billing_contact_scopes (2026-08-31) — a billing contact can be scoped to one or more tenants, projects, or properties in a single bulk call, and span DIFFERENT tenants (cross-tenant). Fallback to tenants.contact_* when no scope matches."
metadata:
  type: project
---

**User's ask:** "Can update billing contact mapping to have the flexibility
to map to whole tenant or a whole project or per property? Cross tenant
also should be possible." Confirmed scope with the user first — this is
**contact/recipient routing only**, not a change to how billable amounts
are computed (`billing_metrics` stays tenant-wide, per
`project-billing-metrics-collector.md`; `project-billing-commission-computation.md`'s
percentage math is unaffected). If per-property/per-project *amounts* are
ever wanted, that's a separate, bigger change (rohas-group's
`GET /api/billing/metrics` would need project/property-level breakdowns).

**Design:**
- `billing_contacts` — a contact is NOT owned by any single tenant
  (name/email/phone/billing_address/gstin/pan/notes).
- `billing_contact_scopes` — one row per (contact, scope) assignment.
  `tenant_id` is always required (every scope belongs to exactly one
  tenant); `tenant_project_id`/`tenant_property_id` are the **tenant's own
  internal ids** — opaque to AmaraData, same convention as
  `owner_tenant_links.tenant_project_id`/`tenant_owner_id`, since AmaraData
  has no projects/properties table of its own. A single contact can hold
  many scope rows across **different** `tenant_id` values — that's the
  cross-tenant capability, no special-casing needed, it falls straight out
  of the data model.
- `scope_type IN ('tenant','project','property')`, enforced shape via a
  CHECK constraint (`billing_contact_scope_shape`): tenant-level scopes
  must have both id columns NULL; project-level needs `tenant_project_id`
  set; property-level needs both set.
- **Two contacts can never claim the identical scope** — a unique
  expression index (`COALESCE(tenant_project_id, 0)`,
  `COALESCE(tenant_property_id, 0)`) rather than a plain UNIQUE constraint,
  since Postgres treats NULLs as distinct in ordinary uniqueness checks and
  would otherwise let multiple tenant-level (NULL/NULL) rows for the same
  tenant slip through.
- **Resolution** (`GET /api/billing-contacts/resolve?tenant_id=&tenant_project_id=&tenant_property_id=`):
  most-specific-wins — property scope beats project scope beats tenant
  scope. If NO scope row matches at all, falls back to the tenant's own
  `contact_name`/`contact_email`/`contact_phone`/`billing_address` columns
  (`matched_scope: 'tenant_default'`) — **additive, not a replacement**;
  nothing that already reads those tenant columns needs to change.

**Endpoints** (`backend/routes/billing-contacts.js`, mounted at
`/api/billing-contacts`): `GET /` (any authenticated staff), `GET /:id`
(contact + its scopes, enriched with `tenant_name`), `GET /resolve`,
`POST/PUT/DELETE /` (requireAdmin), `POST /:id/scopes`,
`DELETE /scopes/:scopeId` (requireAdmin). DELETE on a contact cascades its
scopes (FK `ON DELETE CASCADE`).

**Real gap found and worked around, not fixed:** `GET /api/tenants/:id/modules`
(the only existing tenant-side endpoint that returns real
`{project_id, project_name}` pairs — reused here for a "Load Projects"
picker convenience button) requires **`requireSuperAdmin`**, one level
stricter than `billing-contacts`' own `requireAdmin`. A plain `admin` user
can still fully use this feature — Project ID stays a free-typeable field
regardless — but the picker button 403s for them. Handled gracefully in the
frontend (catches the 403, shows "Only super_admin can browse the live
project list — enter the Project ID directly instead" rather than a raw
error) rather than changing that route's role gate, which is out of scope
for this feature and used elsewhere (`tenants.html`'s Modules button) for
a reason not investigated here.

**Property picker built (2026-08-31, api_version 1.3.56 / amaradata-platform
1.3.16)** — closes the gap noted below. New `GET /api/billing/properties?project_id=&q=`
on rohas-group (`backend/routes/billing.js`), same `serviceAuthMiddleware`/
`AMARADATA_API_KEY` as `/project-modules` and `/metrics` (a billing-config
lookup, not an owner-portal concern — deliberately NOT the owner-portal key).
Requires `project_id` (browse one project's `rental_properties`, no query
needed) or a 2+ character `q` (search by `property_code`/`property_name`
across every rental-management-enabled project via the same `forEachProject`
+ `getEnabledModules` pattern `/metrics` already uses) — same "can't dump
everything with zero scoping" rule as `search-owners`. Returns
`{id, property_code, property_name, city, status, project_id, project_name}`.

- **`backend/services/billing-tenant-client.js`**: new `fetchProperties(tenant, {project_id, q})`,
  reuses the existing `callBillingApi()` helper (same dedicated billing key
  as `fetchMetrics`).
- **`backend/routes/tenants.js`**: new `GET /api/tenants/:id/billing-properties`,
  `requireSuperAdmin` — same gate as `/owner-candidates`, for consistency,
  even though (like owner-candidates) it goes through a dedicated service key
  rather than SSO impersonation. This is a real, pre-existing asymmetry
  (projects' `/modules` proxy is *also* `requireSuperAdmin` despite
  billing-contacts' own write actions only needing `requireAdmin`) — not
  introduced by this change, just matched for consistency rather than fixed.
- **Frontend**: Property ID(s) row gained a `<select multiple>` picker +
  optional search box + "Load Properties" button, identical UX pattern to
  the existing Project(s) picker — `loadTenantProperties()` scopes the
  lookup to the FIRST project id already typed/picked in the Project ID(s)
  field (property ids are only meaningful within one project), and
  `onPropertyPickerChange()` appends picked ids into the same comma-separated
  field so picked and hand-typed ids can mix, exactly like projects.
- **Test coverage**: rohas-group `testing/unittests/api/billing-routes.test.js`
  (8 new tests, both DB and NonDB mode — DB mode asserts against the real
  seeded `RP-AMR-201` row); amaradata-platform `src/test/billing-properties-routes.test.js`
  (8 tests, `billing-tenant-client.fetchProperties` monkey-patched the same
  way `owner-links-routes.test.js` patches `owner-portal-tenant-client`).
  Full suites re-passed both repos: rohas-group 185 files/3355 tests (DB) +
  199 files/3771 tests (NonDB); amaradata-platform 291 (DB) + 42 (NonDB) + 453
  (unittests).
- **Verification**: via the real-Postgres DB-mode test run (not mocked) —
  the DB-mode assertions in `billing-routes.test.js` exercise the actual SQL
  against `rohas_amaracasa_test.rental_properties`, so this stood in for a
  manual curl session (local `.env` has no `AMARADATA_API_KEY` set for the
  dev DB, so a live curl check would have needed extra one-off setup with no
  real added confidence over the DB-mode test).
- **Gotcha hit while testing**: `TEST_DB=1 npx vitest run <file>` directly
  (bypassing `npm run test:db`'s `db-global-setup.js` reseed step) left
  accumulated stray `booking_receipts` rows in `rohas_amaracasa_test` from
  many prior ad-hoc runs of `billing-routes.test.js`'s cooling-off tests
  (which create receipts but never clean them up) — caused one unrelated
  assertion to fail with a stale total. Fixed by truncating the table by
  hand; the real fix going forward is always running via `npm run test:db`
  (which reseeds from `transactiondata/` first), not a bare `vitest run
  --config vitest.config.db.js` invocation.
- **Separate infra gotcha, not code**: two `npm test`/`npm run test:db`
  background runs got killed mid-flight this session (once by an
  inadvertent `ScheduleWakeup stop:true` call with no active loop, once by
  the documented Windows exit-127 spawnSync flakiness) and each left
  `transactiondata/*.json` corrupted (one file truncated to 0 bytes, several
  others rewritten with 50k+ line deletions) — recovered both times via
  `git checkout -- transactiondata/`. No real data was at risk (all `_test`
  DB / local JSON scratch), but worth remembering: after ANY interrupted or
  backgrounded rohas-group test run, check `git status --porcelain
  transactiondata/` before trusting the working tree, not just after a clean
  run.

**Previously flagged gap, now closed by the above:** ~~No "list properties"
endpoint exists anywhere (tenant-side or AmaraData-side) — property id is
always free-typed by staff, sourced from the tenant's own admin UI.~~

**Frontend:** new `frontend/billing-contacts.html`, added to the main nav
(`platform.js`'s `NAV` array, between Billing Metrics and Email) — list +
create/edit/delete contacts, "Manage Scopes" modal per contact (add/remove
scope rows, scope-type-conditional fields, the Load-Projects picker above).
Write buttons hidden via `isReadOnly()` (staff role only) — matches
`invoices.html`/`metrics.html`'s existing convention exactly, including its
known looseness (a `sales_manager`/`billing` role still sees the buttons
and would get a clean 403 from `requireAdmin` if they clicked — pre-existing
pattern in this codebase, not something newly introduced here).

**Test coverage:** `src/test/billing-contacts-routes.test.js` (21 tests:
CRUD, scope CRUD, shape validation, the 409 duplicate-scope conflict, and
the full 4-level resolve precedence including cross-tenant and the
tenant-default fallback) + `nondb-readonly.test.js` gained a resolve test
and 5 write-rejection cases. All three tiers pass: 276 DB + 41 NonDB + 453
unittests.

**Test-isolation gotcha hit while writing this:** two `describe` blocks both
tried to claim a tenant-level scope on the SAME shared `tenantAId` fixture
— the second one silently 409'd (never checked its response status in
`beforeAll`), so a later assertion resolved to the WRONG contact (the first
block's) instead of failing loudly. Fixed by giving the resolve-precedence
tests their own dedicated tenant rather than reusing one already claimed
elsewhere in the file — a reminder that this unique-scope constraint means
tenant fixtures can't be casually shared across describe blocks the way
untouched ones can.

**Verified against the live local dev server, not just automated tests**
(no browser tool available — curl-driven, same caveat as prior features
this session): created two real tenants + one billing contact through the
actual REST API, added a tenant-level scope to one tenant and a
property-level scope to the OTHER tenant on the SAME contact (proving
cross-tenant genuinely works, not just in the test suite), confirmed
`GET /resolve` returns the right contact for each and the graceful
`tenant_default` fallback for a non-matching property, and confirmed the
Load-Projects 403 is caught cleanly for a plain-`admin` test user (not
super_admin). Test tenants/contact/scopes/user cleaned up afterward
(delete was done via raw SQL rather than the API, so the
`transactiondata/*.json` file mirrors had to be manually reset to `[]`
afterward — direct DB writes never go through `mirrorWrite()`).

**Bulk-add (2026-08-31, same day, api_version 1.3.14):** the initial screen
only added one scope at a time. User restated the requirement more
precisely — "a single contact can be scoped to **one or more** tenants,
one or more projects, or one or more properties... in a single action" —
confirmed via `AskUserQuestion` that this meant true multi-select/bulk-add,
not just "the existing one-at-a-time flow already technically allows
several scopes eventually."

- **New `POST /api/billing-contacts/:id/scopes/bulk`** — `{ scopes: [...] }`,
  each entry the same shape as the single-scope endpoint's body. Each entry
  is inserted **independently** (not a single DB transaction) — one bad or
  already-claimed entry never blocks the rest, since a staff member
  bulk-adding 10 properties shouldn't lose all 10 because 1 was already
  assigned elsewhere. Returns `{ created: [...], failed: [{entry, error}] }`
  so the caller knows exactly which landed and why any didn't.
  `insertOneScope()` extracted as a shared helper so the single-scope route
  and the bulk route share identical validation/conflict logic — an
  `.status`-tagged error thrown from the helper becomes either a single
  HTTP response or one `failed` entry, same code path either way.
- **Frontend (`billing-contacts.html`):** the Tenant field became a native
  `<select multiple>` — selecting several tenants with `scope_type='tenant'`
  bulk-creates one tenant-level scope per selected tenant (the cross-tenant
  bulk case). For `scope_type='project'`/`'property'`, exactly one tenant
  must be selected (a project/property id is only meaningful within one
  tenant) and Project ID / Property ID became comma-separated text fields
  (`parseIdList()` — dedupes, silently drops anything that doesn't parse)
  — one scope created per id. The Load-Projects picker also became
  multi-select, appending picked ids into the same comma-separated field
  rather than replacing free-typed ones, so the two entry methods (pick
  from list vs. type by hand) can be mixed in one add. Result message shows
  "N added, M failed: <reasons>" rather than a single pass/fail.
- **Test coverage:** 7 new tests in `billing-contacts-routes.test.js`
  (cross-tenant bulk tenant-add, multi-project-add, multi-property-add,
  partial failure reporting both a shape error and a duplicate-scope
  conflict in the same batch, and a second contact's bulk attempt on an
  already-claimed scope). All tiers re-pass: 283 DB + 42 NonDB + 453
  unittests.
- **Verified against the live local dev server** (curl-driven, no browser
  tool): one bulk call created 2 tenant-level scopes across 2 different
  tenants for the same contact in a single request; a second bulk call
  created 3 project-level scopes on one tenant in one request; a third
  call mixing one new id with one already-claimed id correctly created the
  new one and reported the duplicate as `failed` rather than rejecting the
  whole batch.
