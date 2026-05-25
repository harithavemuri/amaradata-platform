---
name: rohas-group-impl-patterns
description: "Implementation conventions for rohas-group — folder structure, naming, routes, frontend patterns, auth/role system"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c1e1427-c1f7-485b-ab1f-578630994161
---

## Folder Structure
```
backend/auth/          # OAuth logic (GoogleOAuthAuth class)
backend/db/            # Pool setup, user-groups, user-roles
backend/middleware/    # nondb-mode.js (dual-mode), role-auth.js (RBAC)
backend/routes/        # Express route modules (one file per resource)
backend/lambda/        # Lambda function handlers
backend/services/      # Business logic (file-db-service.js for NonDB)
backend/jobs/          # Scheduled tasks (export-db-to-files.js)
backend/graphql/       # GraphQL schema & resolvers
src/pages/             # React components (TypeScript)
src/utils/             # Shared IIFE scripts (sidebar, impersonation, session-timeout)
src/test/              # Vitest setup
database/              # SQL schema files
metadata/              # JSON schema definitions (NonDB mode)
transactiondata/       # JSON data files (NonDB mode)
specs/                 # Spec documents (authoritative requirements)
```

## Naming Conventions
- URL path segments: hyphen-case (`/api/property-features`)
- DB table names: underscore_case (`property_features`, `user_projects`)
- Env vars: UPPERCASE_SNAKE_CASE
- Functions/methods: camelCase
- CSS classes: kebab-case with prefix (`amr-sidebar`, `amr-nav-item`)

## Route Organization
- Mounted at `/api/<resource>` — one file per resource in `backend/routes/`
- Generic metadata CRUD in `backend/routes/generic.js`
- All routes check `req.db.mode` and branch between DB and file-based logic (dual-mode pattern)

## API Versioning
- Via Accept header: `Accept: application/json;v=1` — no URL versioning

## Frontend Page Pattern
- Standalone HTML files at root (not SPA)
- Scripts loaded in `<head>` or `<body>`
- Sidebar rendered at `</body>`: `window.__sidebar.render('nav_key')`
- Session timeout included on all protected pages
- API calls use Fetch with `X-User-Role` + `X-User-Email` headers from localStorage

## Role System (17 roles)
super_admin, admin, tenant_admin, project_admin, property_developer,
sales_manager, sales_executive, marketing_manager, financial_manager,
customer_support, compliance_officer, it_support,
property_owner, nri_owner, unit_user

- RBAC enforced server-side by `roleAuthMiddleware` (reads X-User-Role/X-User-Email headers)
- project_admin scoped to allowed projects via user_projects join
- sales_person scoped to allowed properties via user_properties join
- Admin-only impersonation: real role in `localStorage('role')`, impersonated in `localStorage('amr_impersonated_role')`
- Nav items filtered client-side using `data-nav="nav_key"` attributes

## Database Patterns
- No ORM — parameterized SQL via `pg`
- Read/write pool separation; SELECTs auto-route to readPool
- Per-table JSON schema in `metadata/<table>.schema.json`
- FileDB service API: `find()`, `getById()`, `create()`, `update()`, `delete()`, `aggregate()`
- Export job syncs PostgreSQL → JSON files; sync command reverses

## JWT / Auth Pattern
- PKCE OAuth: frontend generates state + code_verifier, backend verifies on callback
- JWT payload: `{sub, email, name, picture, projectId, iat, exp, type}`
- Refresh: `POST /auth/refresh` with 1-hour refresh token
