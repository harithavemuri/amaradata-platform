---
name: project-business-model
description: Big-picture product model — amaradata-platform is the SaaS control plane; tenant-group (rohas-group) is the per-tenant site, dedicated or colocated on cloud.amaradata.com; amaradata-portal is the shared owner/renter dues site
metadata:
  type: project
---

amaradata-platform is the SaaS control plane for property owners managing sales and rentals through the `tenant-group` repo (= `rohas-group`, see [[project-tenant-onboarding]]).

- **Tenant** = the property/rental owner who wants their own site (e.g. `rohas.amaradata.com`); each is a deployment of the same tenant-group code with `Tenant=<slug>`.
- **Colocation**: tenants OK sharing are hosted as projects inside the shared `cloud` stack (`cloud.amaradata.com`, stack `cloud-prod`, DB `amaradata_cloud`), not a separate runtime per owner.
- **Owners** see dues/payments on `amaradata-portal` (portal.amaradata.com). **Renters are the stated intent but NOT built** — portal accepts only `property_owner`/`super_admin`.
- **Enablement, as actually implemented**: only per-project modules (`sales_management`/`rental_management`/`ai_management`) are toggled from here, as an SSO-proxied write-through to the tenant, whose `project_module_mapping` is the store of record ([[project-tenant-modules-sso]]). `tenants.status` is a label with no found enforcement; tenant onboarding is manual. `/sso/issue` login_url is hardcoded to `ROHAS_URL`.

**Why:** user stated this model 2026-10-04; details verified against all three repos the same day.

**How to apply:** treat dedicated and colocated as equal hosting modes when refactoring tenants/slug/SSO audience/billing/portal fan-out. Don't describe renters or tenant-level suspension as working features. See pending questions in the 2026-10-04 review if still open.

**Decisions confirmed by user 2026-10-04 (intent, mostly not yet built):**
- Disabling a tenant must block that tenant site's users from logging in; on the shared `cloud` stack, block the users of the disabled property. (`tenants.status` enforces nothing today.)
- Platform is to become the source of truth for module enablement; tenants sync from it (today: tenant-owned, write-through).
- `/sso/issue` is still used for human logins → needs per-tenant `login_url` from `tenants.site_url` (today hardcoded `ROHAS_URL`).
- Never commit in `tenant-group` or `amaradata-portal`; only amaradata-platform ([[feedback-amaradata-repo-commits-only]]).
- **Undecided:** colocated-customer ↔ `tenants` row/billing mapping; renter modeling. Ask before designing around either.

**Progress 2026-10-04:** built in amaradata-platform (uncommitted): (1) `/sso/issue` resolves tenant from `tenants`, 404 unknown / 403 non-active, login_url from `site_url`, `ROHAS_URL` removed; (2) `tenant_module_settings` = platform source of truth, PUT saves-then-pushes, `POST /:id/modules/sync` reconciles, GET shows drift. **Still open:** tenant-site direct-login blocking on suspend (needs tenant-group change + push/pull decision), drift/Sync UI in `tenants.html`. The local `_test` DB needed `tenant_module_settings` applied by hand (test setup doesn't run schema.sql).
