---
name: feedback-tenants-list-credential-leak
description: "GET /api/tenants leaked plaintext tenant_db_password/owner_portal_api_key to any staff role; fixed by sanitizing the response, not by narrowing the auth guard"
metadata:
  type: project
---

**Found 2026-08-30, during the standing post-deploy security review** after
shipping the owner-portal identifier redesign: `GET /api/tenants`
(`backend/routes/tenants.js`) only required `requireAuth` (any valid staff
login — `staff`/`sales_manager`/`billing`, not just `admin`/`super_admin`)
and did `SELECT * FROM tenants`, so it returned `tenant_db_password`
(plaintext) and `owner_portal_api_key` (plaintext) to every logged-in staff
member regardless of role. Pre-existing before this session (the columns
were added earlier), but flagged now because Phase B just made
`owner_portal_api_key` operationally load-bearing.

**Why the fix narrows the response instead of narrowing the auth guard:**
the only real caller (`frontend/user-groups.html`) needs `id`/`name` for a
tenant picker, not credentials, and isn't itself admin-gated — restricting
the whole route to `requireAdmin` would have broken that legitimate,
lower-privilege use. `tenants.html`'s own list actually goes through
GraphQL (`{ tenants { id name slug ... } }`), which was already safe by
construction — the `Tenant` GraphQL type in `typeDefs.js` never declares the
sensitive fields at all, so no resolver-level fix was needed there.

**Fix:** `sanitizeTenant()` strips `tenant_db_host/port/name/user`,
`tenant_db_secret_arn`, `tenant_db_password`, `owner_portal_api_key(_secret_arn)`
from `GET /api/tenants`'s response only (both DB and NonDB modes) —
`requireAdmin`-gated routes (`POST`/`PUT /:id`) still return the full row on
purpose, since an admin setting these values needs to see what was saved.
Test added: `src/test/tenants-routes.test.js`'s new `describe('GET
/api/tenants')` block, seeding a tenant with real-looking secret values and
asserting they never appear in the list response for a `staff`-role caller.
No test existed for this endpoint before — that's exactly how the leak went
unnoticed.

**How to apply:** any time a new sensitive column is added to a table with an
existing "list everything" endpoint, check that endpoint's actual auth guard
and `SELECT` shape — don't assume `SELECT *` behind `requireAuth` is safe just
because a *different*, more privileged endpoint on the same table already
handles that field correctly.
