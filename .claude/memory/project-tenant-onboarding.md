---
name: project-tenant-onboarding
description: "rohas-group repo IS the generic tenant-platform codebase (not a one-off repo for one tenant) — new tenants are new deployments of the same codebase, each getting {tenant}.amaradata.com; AmaraData will have multiple tenants"
metadata:
  type: project
---

**Corrected understanding (supersedes this file's earlier framing):** `rohas-group` is not "a repo for the rohas tenant" — it **is** the generic "tenant-platform" codebase. Every tenant deploys the *same* code as its own isolated CloudFormation stack, parameterized by the `Tenant` template parameter (`sam deploy --stack-name acme-prod --parameter-overrides Tenant=acme Env=prod ...`, per `template.yaml`'s own header comment: "A new tenant gets its own isolated stack and /<tenant>/ path tree... every deploy must be explicit about which tenant it's deploying. Nothing silently becomes rohas."). Each tenant gets its own subdomain, `{tenant}.amaradata.com` (e.g. `rohas.amaradata.com`). **AmaraData will have multiple tenants** — rohas is the first, not the only one, and more are expected. A "new tenant" is very likely a new *deployment* of the existing tenant-platform repo, not a new repo, unless a tenant genuinely needs code that diverges from the template.

[[rohas-group-tech-stack]] and [[rohas-group-constraints]] describe the tech stack this template uses (Express + dual-mode data layer + AWS SAM + SSO consumer).

**Cross-system convention this creates — critical for [[project-tenant-modules-sso]] and anything else calling into a tenant site:** AmaraData's `tenants.slug` column (used as the SSO token's `aud` claim) **must exactly match** the `Tenant` CloudFormation parameter value used to deploy that tenant's stack (which the tenant-platform's own `backend/lambda/auth-sso.js` compares `aud` against, via `process.env.TENANT`). If these two values ever diverge for a tenant — a typo, a rename, forgetting to update one side — SSO silently breaks for that tenant with "SSO token not intended for this service." **Found broken for rohas even today**: rohas-group's `template.yaml` never actually sets a bare `TENANT` env var on `AuthSsoFn` (only `TENANT_LOGO_URL`/`TENANT_SEED_SQL` exist), so `process.env.TENANT` is `undefined` in the deployed Lambda and the aud check fails for every tenant, always, until that's fixed (`TENANT: !Ref Tenant` needs adding to `AuthSsoFn`'s `Environment.Variables`) and redeployed — this is a rohas-group-side bug, out of scope to fix directly (standing no-commit-to-rohas-group rule), reported to the user instead.

**New tenant workflow:** when the user asks to onboard a new tenant, do not scaffold it unprompted from assumptions. Instead:
1. Deploy a new stack from the tenant-platform (rohas-group) codebase with `Tenant=<slug>` (only fork to a genuinely new repo if that tenant needs code the template can't parameterize its way to).
2. Create the matching `tenants` row in AmaraData with `slug` set to the **exact same** value used for `Tenant` — this is what makes SSO/`project-tenant-modules-sso` work for that tenant.
3. List the available features/modules and ask the user which ones should be enabled for that tenant — do not assume all features are on by default.
4. Billing for that tenant is based on which features were enabled (feature-gated billing, not flat-rate).

**Why:** User explicitly stated this is the standing process for onboarding any future tenant, and that billing must map to enabled features rather than a fixed plan. The repo-vs-deployment correction came from the user directly: "'rohas-group' repo represents 'tenant-platform', each tenant will have their own {tenant}.amaradata.com... Amaradata will have multiple tenants."

**How to apply:** Any request to "create a new tenant" or "onboard <name> as a tenant" should trigger: new stack deployment (not necessarily new repo) → matching `tenants.slug` in AmaraData → feature selection question to the user → billing config reflecting only the selected features (likely via `tenant_subscriptions`/`subscription_plans` tables in amaradata-platform's schema, given the existing billing domain model).
