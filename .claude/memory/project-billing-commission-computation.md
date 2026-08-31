---
name: project-billing-commission-computation
description: "GET /api/invoices/suggest-line-items (2026-08-31) computes rental/sales commission from billing_metrics x subscription_plans.rental_pct/sales_pct — previously 'Rental %'/'Sales %' were just dropdown labels a staff member had to compute by hand"
metadata:
  type: project
---

**Found while answering the user's question "does billing handle rental
properties management commission?":** the *data collection* side
(`GET /api/billing/metrics`, `billing_metrics` table — see
`project-billing-metrics-collector.md`) was correct and working, but
`subscription_plans.sales_pct`/`rental_pct` were **never actually applied
anywhere**. `invoices.html`'s line-item form had "Sales %"/"Rental %" as
dropdown options, but they were pure labels — the actual amount was always
a manually-typed Qty × Unit Price. A staff member had to compute
"5% of ₹240,000 = ₹12,000" themselves.

**User's explicit business rule (confirmed, not assumed):** "It's should
[be] based on percentage of rental collected by tenants rental properties"
— i.e. `rental_pct` applies to `billing_metrics.rental_income` (real rent
collected, from rohas-group's `rent_payments.paid_amount` via
`GET /api/billing/metrics`), not to rohas's own internal
`rent_payments.management_fee_amount` commission (which is Rohas's revenue
from the property owner, a completely separate concept — see
`admin/metadata/owner-payments.html` on rohas-group's side). Confirmed this
distinction with the user before building anything.

**Fix: `GET /api/invoices/suggest-line-items?tenant_id=&period_year=&period_month=`**
(`backend/routes/invoices.js`, `requireAuth` only — read-only, no write
guard needed):
- Looks up the `billing_metrics` row for that tenant+period (404 with
  "run Collect Metrics Now first" if missing — ties directly into the
  button built earlier the same day).
- Looks up the `tenant_subscriptions` row that was **active during that
  period** (`effective_from <= period end` AND
  `effective_to IS NULL OR effective_to > period end`) — not just
  "currently active" — so re-invoicing a past period after the plan has
  since changed still uses the rate that applied at the time. This matters
  because invoices can legitimately be created for a prior month.
- Effective rate = `custom_sales_pct`/`custom_rental_pct`/`custom_min_fee`
  (per-tenant override on `tenant_subscriptions`) if set, else the plan's
  own default — confirmed correct precedence with a dedicated test.
- Computes `sales_value × sales_pct` and `rental_income × rental_pct` as
  two separate line items, then a floor top-up line item if the combined
  total is below the plan's `min_monthly_fee`.
- Shared pure function `computeSuggestedLineItems()` used by both DB mode
  (real SQL join) and NonDB mode (in-memory `fileDb.find()` equivalent) —
  same response shape either way, matching
  `feedback_api_nondb_architecture`'s "only retrieval differs" rule. This
  endpoint had no NonDB branch at all in its first draft — caught and fixed
  before committing, since every other GET in this codebase supports both
  modes and an inconsistency here would have silently 500'd in NonDB mode.

**Frontend (`frontend/invoices.html`):** new "Suggest from Metrics" button
next to "+ Add Line" in the New Invoice form. Reads whatever Tenant +
Billing Period (`YYYY-MM`) are already selected, calls the endpoint,
replaces the current line items with the computed ones. Every field stays a
normal editable input — staff reviews/edits/deletes before clicking "Create
Invoice"; this never auto-submits an invoice. `addLine()` was refactored to
accept an optional prefill object so both the blank "+ Add Line" path and
the computed-suggestion path share the same row-rendering code.

**Test coverage:** `src/test/invoice-suggest-line-items-routes.test.js` (7
tests: auth, missing params, no-metrics 404, correct computation, custom
override wins, min-fee top-up, no-subscription 400) plus one NonDB-mode
test added to the existing `nondb-readonly.test.js` (proves the shared
computation function produces identical results in both modes). All three
tiers re-run clean after this change: 255 DB + 35 NonDB + 453 unittests.

**Verified against the live local dev server, not just automated tests**
(no browser tool available — curl-driven end-to-end, same caveat as the
Collect Metrics Now button's verification): created a real tenant/plan/
subscription/metrics row through the actual REST API (not direct SQL),
confirmed `frontend/invoices.html` serves the new button markup, then
called the exact URL the button calls and got the correct computed amounts
back (5% of ₹2,000,000 = ₹100,000 sales; 10% of ₹80,000 = ₹8,000 rental;
combined clears the ₹2,000 floor, no top-up line). Test tenant/plan/
subscription/metrics/user cleaned up afterward.

**Deliberately out of scope, left for later if asked:**
- `hourly_rate` (enhancement-based billing) isn't part of this endpoint —
  that's driven by `enhancements` rows, a different data source than
  `billing_metrics`, and would need its own suggestion logic.
- `collect-metrics.js` still never sets `billing_metrics.subscription_id`
  (a pre-existing, separate gap noted in `project-billing-metrics-collector.md`)
  — this endpoint does its own independent subscription lookup by period,
  so it doesn't depend on that column being populated, but it means
  `billing_metrics.subscription_id` stays permanently NULL until that's
  fixed separately.
