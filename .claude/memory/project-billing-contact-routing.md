---
name: project-billing-contact-routing
description: "billing_contacts + billing_contact_scopes (2026-08-31) — a billing contact can be scoped to a whole tenant, one project, or one property, and a single contact can span DIFFERENT tenants (cross-tenant). Fallback to tenants.contact_* when no scope matches."
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

**No "list properties" endpoint exists anywhere** (tenant-side or
AmaraData-side) — property id is always free-typed by staff, sourced from
the tenant's own admin UI. A live property picker would need new
tenant-side work (a new service-authenticated endpoint on rohas-group,
mirroring how `owner-portal.js`'s `GET /search-owners` already works) —
not built, flagged as a known limitation.

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
