---
name: project-tenant-onboarding
description: "rohas-group is currently the only AmaraData tenant; workflow and billing model for onboarding new tenants"
metadata:
  type: project
---

**rohas-group is the only tenant today.** [[rohas-group-tech-stack]] and [[rohas-group-constraints]] describe it; the pattern documented there (Express + dual-mode data layer + AWS SAM + SSO consumer) is the template for any future tenant, not just historical detail about one repo.

**New tenant workflow:** when the user asks to create a new tenant, do not scaffold it unprompted from assumptions. Instead:
1. Create a new repo modeled on rohas-group's structure (Express server, dual-mode DB layer, SAM template, SSO consumer wired to the shared `SSO_SECRET`, same VPC/Aurora-cluster-sharing pattern as [[project-amaradata-domain]] describes for amaradata-platform).
2. List the available features/modules and ask the user which ones should be enabled for that tenant — do not assume all features are on by default.
3. Billing for that tenant is based on which features were enabled (feature-gated billing, not flat-rate).

**Why:** User explicitly stated this is the standing process for onboarding any future tenant, and that billing must map to enabled features rather than a fixed plan.

**How to apply:** Any request to "create a new tenant" or "onboard <name> as a tenant" should trigger: repo scaffold from rohas-group → feature selection question to the user → billing config reflecting only the selected features (likely via `tenant_subscriptions`/`subscription_plans` tables in amaradata-platform's schema, given the existing billing domain model).
