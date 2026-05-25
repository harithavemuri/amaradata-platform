---
name: fix-issues
description: >
  Process Issues/RohasTestNotesSheet.csv — apply fixes to the named site (including all
  affected modules), write a Vitest unit test per issue, run it, mark Fixed?, populate
  Fix Details, classify as Bug or Enhancement, mark Billable, and write
  Issues/RohasTestNotesSheet_Fixed.csv (importable to the amaradata issue_fixes table).
---

# Fix Issues — RohasTestNotesSheet.csv

> **Before starting:** read the project CLAUDE.md files and all memory files — they are the
> single source of truth for constraints, patterns, and rules.
>
> - `C:\Haritha\github\amaradata-platform\CLAUDE.md`
> - `C:\Haritha\github\rohas-group\CLAUDE.md` (if present)
> - `C:\Haritha\github\rohas-group\.project-constraints`
> - `C:\Users\jatin\.claude\projects\C--Haritha-github-amaradata-platform\memory\MEMORY.md`

---

## Input CSV columns

`Issueid, Report Date, Notes, Task Type, Site Name, Tenant Name, Apply Fix?, Fixed?`

Parse each data row as: `{ issueId, reportDate, notes, taskType, siteName, tenantName, applyFix, fixed }`

- `Task Type`: `Task` (user-initiated change/feature request) or `Bug` (reported defect) — primary classification hint
- `Tenant Name`: the AmaraData tenant this work was done for (e.g. `Rohas Group`) — used to auto-assign the row when importing into the enhancements table

---

## Project roots

| Site Name   | Absolute path                          |
|-------------|----------------------------------------|
| rohas-group | `C:\Haritha\github\rohas-group`        |
| amaradata   | `C:\Haritha\github\amaradata-platform` |

---

## Step 1 — Load and triage

1. Read `C:\Haritha\github\amaradata-platform\Issues\RohasTestNotesSheet.csv`.
2. Parse all data rows using the column order above.
3. Separate into:
   - **To-do**: `applyFix === 'Yes'` AND `fixed` is blank.
   - **Already done**: `fixed` is non-empty — preserve as-is.
   - **Skipped**: `applyFix !== 'Yes'` — preserve as-is.
4. Print: `CSV triage: N to-do | M already fixed | K skipped (Apply Fix? ≠ Yes)`

---

## Step 2 — Process each to-do issue in order

### 2a — Announce
```
────────────────────────────────────────────────────────────
[Issue #<issueId>] <reportDate> | <notes truncated to 80 chars>
────────────────────────────────────────────────────────────
```

### 2b — Skip check
If Notes contain "needs to be discussed", "discuss before working", or "to be discussed":
set `fixed = 'SKIP – needs discussion'`, `fixDetails = 'No changes made.'`, `itemType = 'enhancement'`, `billable = 'No'`, and move on.

### 2c — Classify the issue

Before fixing, classify each issue as **Bug** or **Enhancement**.

Use `Task Type` from the CSV as the primary signal, then refine with Notes:

| CSV Task Type | Default output Type | Billable? | Refine when… |
|---------------|---------------------|-----------|--------------|
| `Task` | enhancement | Yes | Never — Tasks are always billable enhancements |
| `Bug` | bug | No | Notes describe a new feature, new filter, new UI element → override to enhancement + billable |

Override rule (Bug → enhancement): if Notes request something **new** (new dropdown, new screen, new
login method, new column, improved UX) rather than fixing something **broken**, classify as enhancement.

| Type | When to use |
|------|-------------|
| **bug** | Broken functionality, wrong spelling, page not loading, 401 redirect instead of content, wrong label |
| **enhancement** | New feature, new filter, new column, new UI element, improved UX, new login method |

| Issueid | Classification | Billable? | Reason |
|---------|---------------|-----------|--------|
| 1 | enhancement | Yes | New login method (email/password in addition to Google) |
| 2 | enhancement | Yes | User account setup/configuration |
| 3 | enhancement | Yes | User-project access configuration |
| 4 | enhancement | Yes | New dashboard widget (Unit Status summary) |
| 5 | enhancement | Yes | Short username login support |
| 6 | enhancement | Yes | New search filter (floor number) |
| 7 | enhancement | Yes | New project dropdown filter on unit bookings |
| 8 | bug | No | Typo/spelling correction ("All Statuses" → "All Status") |
| 9 | enhancement | Yes | Configurable session timeout with warning modal |
| 10 | enhancement | Yes | Project filter first on Property Types screen |
| 11 | enhancement | Yes | Project filter first on Unit Type Variants screen |
| 12 | bug | No | Missing validation before navigating to payment schedule |
| 13 | enhancement | Yes | Individual search dropdowns on Saved Estimates grid |
| 14 | enhancement | Yes | Individual search dropdowns on Payment Schedule grid |
| 15 | bug | No | Payment Schedule not loading from sidebar (missing server route) |
| 16 | enhancement | Yes | Password reset field for super admin in Users screen |
| 17 | bug | No | User display label shows number instead of name |
| 18 | enhancement | Yes | Sales Assignments (SKIP – needs discussion) |
| 19 | bug | No | Payment Tracker logs user out instead of showing Under Development |
| 20 | enhancement | Yes | Forgot password link |
| 21 | bug | No | Dashboard showing only 1 floor instead of all building units for sales manager |

### 2d — Understand, locate, and fix ALL affected modules

Read Notes in full. Identify every component the issue touches. **If a fix requires changes
in multiple modules (e.g., backend route + HTML + seed data + env var), fix ALL of them.**
Do not stop at the first file — trace the full impact.

Common locations for rohas-group:

| What | Where |
|------|-------|
| Root HTML pages | `*.html` (login, payment-schedule, payment-tracker, price-estimator, etc.) |
| Admin screens | `admin/*.html`, `admin/metadata/*.html` |
| Unit master screens | `unit-master/*.html` |
| Backend routes | `backend/routes/*.js` |
| Lambda functions | `backend/lambda/*.js` |
| Auth / middleware | `backend/middleware/*.js`, `backend/auth/*.js` |
| Sidebar / nav | `src/utils/sidebar.js` |
| Session timeout | `src/utils/session-timeout.js` |
| Server mount | `backend/server.js` |
| NonDB seed data | `transactiondata/*.json` |
| ENV var docs | `.env.example` |

**Multi-module examples:**
- Session timeout warning → `src/utils/session-timeout.js` (logic) + `.env.example` (SESSION_TIMEOUT doc)
- New login type → `backend/lambda/auth-email-login.js` + `login.html` (UI) + `transactiondata/users.json` (seed)
- Project dropdown on all filter screens → every screen that has a filter bar (`property-types.html`, `unit-type-variants.html`, `admin/metadata/properties.html`, etc.)
- Payment page not loading → `backend/server.js` (route mount) + HTML file + sidebar nav entry

Record every file changed in `fixDetails` as: `"file1.js (why), file2.html (why), …"`

### 2e — Write the unit test

File: `C:\Haritha\github\rohas-group\src\test\issues\issue-<issueId>.test.js`

```js
// issue-<issueId>.test.js — <reportDate>: <notes first 60 chars>
import { describe, it, expect } from 'vitest';
```

Test strategy by fix type:

| Fix type | How to test |
|----------|-------------|
| Typo | `fs.readFileSync` the HTML; assert correct string present, wrong string absent |
| Added link/element | Read HTML; assert the substring exists |
| New/updated auth route | `supertest` POST to the route; assert status + response shape |
| NonDB user seed | Read `transactiondata/users.json`; assert user with email + role exists |
| Validation gate | Test that navigating without required fields is blocked |
| "Under Development" page | Read HTML; assert no redirect/logout; assert banner text present |
| Project dropdown first | Read HTML; assert project `<select>` appears before other filter selects |
| Session timeout env | Read `session-timeout.js`; assert it reads `SESSION_TIMEOUT` env var |
| Route mounts | `supertest` GET the route; assert 200 |
| Multi-module | Write one `describe` block per module changed, assert each |

Tests must be fast and deterministic — file reads and supertest only; no real DB, no network.

### 2f — Run the test

```bash
cd C:\Haritha\github\rohas-group
npx vitest run src/test/issues/issue-<issueId>.test.js --reporter=verbose
```

### 2g — Record result

| Outcome | `fixed` value |
|---------|---------------|
| All tests pass | `Yes` |
| Any test fails | `No – <first error line, ≤120 chars>` |
| Skipped | `SKIP – <reason>` |
| No testable surface | `Yes (manual verify)` |

---

## Step 3 — Write output CSV

Write `C:\Haritha\github\amaradata-platform\Issues\RohasTestNotesSheet_Fixed.csv`.

**Output columns (in order):**
`Issueid,Report Date,Notes,Task Type,Site Name,Tenant Name,Apply Fix?,Fixed?,Fix Details,Type,Billable`

Column definitions:
- `Task Type`: pass through from input (`Task` or `Bug`)
- `Tenant Name`: pass through from input — used by the AmaraData import to auto-match the tenant
- `Fix Details`: comma-separated list of files changed with a one-line reason each
- `Type`: `bug` or `enhancement` (lowercase, matches the `enhancements.item_type` DB column)
- `Billable`: `Yes` for enhancements, `No` for bugs (maps to `enhancements.is_billable`)
- Preserve all rows including skipped and already-fixed ones
- Quote any field that contains commas
- Do NOT modify the input file

**This CSV is designed to be uploaded to the AmaraData platform** via the Enhancements screen
(↑ Upload CSV button). It upserts rows into the `enhancements` table keyed on `(tenant_id, issue_id)`.
`Tenant Name` is used to auto-resolve the tenant — no manual selection needed.
`Type` and `Billable` drive billing: enhancements are billable, bugs are not.

---

## Step 4 — Print final summary table

```
│ Id │ Date         │ Notes (first 45 chars)        │ Tenant      │ Type        │ Billable │ Fixed?  │ Fix Details (truncated)     │
│  1 │ May 28 2026  │ change the login from…        │ Rohas Group │ enhancement │ Yes      │ Yes     │ login.html, auth-email…     │
  …
Output: Issues/RohasTestNotesSheet_Fixed.csv
Tests:  C:\Haritha\github\rohas-group\src\test\issues\issue-*.test.js
```

---

## Issue-specific hints (pre-researched)

These reflect what was actually found in the codebase — do not re-discover, just apply.

| Id | Date | Type | What was found | What to do |
|----|------|------|----------------|------------|
| 1 | May 28 2026 | enhancement | `login.html` already has both Google and email/password forms. `/auth/email-login` lambda already exists (`backend/lambda/auth-email-login.js`) and does bcrypt verify. | Verify login.html shows email/password form prominently. Email/password form is already present with a divider "or". No new route needed. |
| 2 | May 28 2027 | enhancement | `harithavemuri@gmail.com` (id=12, super_admin) and `rayinmail99@gmail.com` (id=10, sales_person) already exist in `transactiondata/users.json` with valid `password_hash` values. Both are in `user_roles.json`. | Confirm both have non-empty `password_hash`. The lambda already uses bcrypt. Already working. |
| 3 | May 28 2028 | enhancement | Both user ids 12 and 10 already have entries in `transactiondata/user_projects.json`. User 12 (harithavemuri) has projects 1, 2, 3. User 10 (rayinmail99) has project 1. | Confirm entries exist — already implemented. |
| 4 | May 28 2029 | enhancement | `admin/dashboard.html` has a stats cards section (`id="statsCards"`) with `renderStatsCards()` that already shows Total, Available, Booked, Sold, Reserved counts. Unit Status screen = `unit-master/status.html`. | Dashboard already shows unit status summary. Write test to assert `statsCards` div exists and the function `renderStatsCards` is present. |
| 5 | May 28 2030 | enhancement | `auth-email-login.js` looks up users by exact `email` field only. Short ids "harithavemuri" and "rayinmail99" won't match because no `@` in the value. | Update `auth-email-login.js` NonDB path: if the input contains no `@`, match on `first_name` (case-insensitive) instead of `email`. Keep exact email match for inputs with `@`. |
| 6 | May 28 2031 | enhancement | `admin/metadata/properties.html` has `filters: [{ key: 'project_id', label: 'Project', entity: 'projects', labelField: 'name' }]`. Floor number filter is missing. | Add `{ key: 'floor_number', label: 'Floor', type: 'number' }` to the filters array in `admin/metadata/properties.html`. |
| 7 | May 28 2032 | enhancement | `admin/metadata/unit-bookings.html` filters only by `booking_type`. `properties.status` and `booking_type` are separate fields. | Add `{ key: 'project_id', label: 'Project', entity: 'projects', labelField: 'name' }` as the FIRST filter in unit-bookings.html. Add note in Fix Details about Sold/Active separation: booking_type='sold' does NOT auto-update property.status — they are two independent fields. |
| 8 | May 28 2033 | bug | `unit-master/car-parking.html` line 116 has `"All Statuses"`. The admin/metadata/car-parking.html uses maintenance.js (no hardcoded text). | Change `"All Statuses"` → `"All Status"` in `unit-master/car-parking.html`. |
| 9 | May 28 2034 | enhancement | `src/utils/session-timeout.js` has 15-min hard-coded timeout (`TIMEOUT_MS = 15 * 60 * 1000`), no warning modal, just calls `doLogout()`. `.env.example` has no `SESSION_TIMEOUT`. Also update `backend/server.js` `/api/site-config` to expose `sessionTimeoutMinutes`. | Refactor `session-timeout.js`: (1) fetch `/api/site-config` on init to get `sessionTimeoutMinutes` (default 30). (2) Show a warning modal 2 min before expiry with a "Stay signed in" button that resets the timer. (3) Add `SESSION_TIMEOUT` to `.env.example`. (4) Add `sessionTimeoutMinutes: Number(process.env.SESSION_TIMEOUT) \|\| 30` to the site-config response in `backend/server.js`. Multi-module: `session-timeout.js`, `.env.example`, `backend/server.js`. |
| 10 | May 28 2035 | enhancement | `admin/metadata/property-types.html` CFG has no `filters` array. | Add `filters: [{ key: 'project_id', label: 'Project', entity: 'projects', labelField: 'name' }]` to the CFG in property-types.html. |
| 11 | May 28 2036 | enhancement | `admin/metadata/unit-type-variants.html` CFG has no `filters` array. | Add `filters: [{ key: 'project_id', label: 'Project', entity: 'projects', labelField: 'name' }]` to the CFG in unit-type-variants.html. Note: property_types and unit_type_variants don't have a `project_id` column — the filter is a UI convenience using the maintenance.js filter mechanism. |
| 12 | May 28 2037 | bug | `doViewSchedule()` in `price-estimator.html` already calls `if (!validateCustomer()) return;` at line 713. Unit selection check uses `buildEstimate()` — if no unit is selected, it returns null and shows "Select a unit first." | Already implemented correctly. Write test to assert `doViewSchedule` contains the `validateCustomer` call. Mark Yes. |
| 13 | May 28 2038 | enhancement | `saved-estimates.html` has a single `.se-search` text input. The toolbar is in `.se-toolbar`. | Replace the single `<input class="se-search">` with four `<select>` dropdowns: Flat No, First Name, Phone, Lead. These are loaded dynamically from saved estimation data. Add a "Clear" button. Keep the count display. |
| 14 | May 28 2039 | enhancement | `payment-schedule.html` is primarily a detail view (loaded with a GUID from price estimator) not a grid/list. There is no list/grid view for payment schedules. | Add a "Browse" button or link to `saved-estimates.html` which already IS the payment schedule grid, since saved estimates include payment schedule data. If a separate payment schedule list view exists, add dropdowns there. Otherwise: update Fix Details noting the grid is `saved-estimates.html` and point there. |
| 15 | May 28 2040 | bug | `payment-schedule.html` exists. Sidebar nav entry: `{ nav:'payment_schedule', href:'/paymentschedule' }`. `backend/server.js` has no route for `/paymentschedule`. `express.static` serves files by exact filename only. | Add to `backend/server.js`: `app.get('/paymentschedule', (req, res) => res.sendFile(path.join(__dirname, '..', 'payment-schedule.html')));`. Also add for `/payment-schedule` as alias. |
| 16 | May 28 2041 | enhancement | `admin/users.html` has a user management panel. `backend/routes/user-admin.js` exists. | Add a password reset input (type="password") to the edit panel in `admin/users.html` that appears only for `super_admin` role. On submit, POST to `/api/user-admin/users/:id/reset-password` endpoint. Add that endpoint to `backend/routes/user-admin.js` — bcrypt hash with cost 12, update the user record in NonDB mode (update `users.json`) and DB mode. |
| 17 | May 28 2042 | bug | `admin/metadata/user-projects.html` uses `labelField: 'name'` for user lookup, but `users.json` has `first_name`/`last_name` fields (no single `name` field). The GQL_MAP in maintenance.js queries `name` from users but it's empty. | Change `labelField: 'name'` to `labelField: 'first_name'` for the user lookup in user-projects.html. Also: to show full name, check if maintenance.js supports a computed label via `labelFn` — if not, update maintenance.js to fall back to `first_name + ' ' + last_name` when `labelField='name'` returns empty. Add a Delete button by verifying maintenance.js delete wiring for user-projects entity. |
| 18 | May 28 2043 | enhancement | Notes say "needs to be discussed before working." | **SKIP** — set fixed = 'SKIP – needs discussion'. Billable = No (not implemented). |
| 19 | May 28 2044 | bug | `payment-tracker.html` has full page content and loads properly. The 401 is triggered by JWT auth middleware. | Add an "Under Development" overlay div to `payment-tracker.html` that is shown by default. Wire the sidebar's 401/fetch-error handler to show this overlay instead of redirecting to login. The simplest fix: check in the page script if the backend returns 401 and show the under-development message rather than letting the sidebar redirect. |
| 20 | May 28 2045 | enhancement | `login.html` has `<a href="forgot-password.html">Forgot password?</a>` at line 352. `forgot-password.html` and `reset-password.html` both exist in root. | Verify both pages exist and the link works. Mark as `Yes`. Fix Details: "Already implemented — verified link in login.html line 352, forgot-password.html and reset-password.html both exist." |
| 21 | May 28 2026 | bug | `admin/dashboard.html` has `renderStatsCards()` which calls `/api/properties` to get unit counts. The API may be filtering by the user's assigned project/property too aggressively for sales_person role, or the frontend is not aggregating across all floors. | Investigate the `/api/properties` endpoint in `backend/routes/generic.js` or a specific properties route to see if it filters by user role. Check if the dashboard stats aggregation logic in `renderStatsCards()` correctly sums across all floors for sales_person. Fix the filtering or aggregation to show all building units regardless of floor. |
