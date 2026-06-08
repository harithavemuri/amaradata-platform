# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AmaraData Platform — Developer Guide

### Setup

```bash
npm install
cp .env.example .env        # fill in DB credentials and JWT secret
psql -U postgres -d amaradata_platform -f database/schema.sql
npm run dev
# → http://localhost:9000
```

### NonDB mode (no database required)

```bash
cp .env.nondb.example .env
npm run dev:nondb
# or: NONDB_MODE=true npm start
```

Data lives in `transactiondata/*.json`. Seed from a live DB at any time:

```bash
npm run export-db              # all tables
npm run export-db tenants,invoices  # specific tables
```

### CLI

```bash
node scripts/cli.js export-db [tables]   # DB → JSON files
node scripts/cli.js serve-nondb          # start in file-based mode
node scripts/cli.js check-db             # test DB connectivity
node scripts/cli.js stats                # row counts per table
node scripts/cli.js sync [--dry-run]     # JSON files → DB
```

### Testing

```bash
npm test                                    # run all tests once
npm run test:watch                          # watch mode
npx vitest run src/test/auth-routes.test.js # run a single test file
```

Tests use Vitest + jsdom + supertest. Setup: `src/test/setup.js` (sets `NONDB_MODE=true`).

**Critical test rule:** Every `/api/*` response must carry `Content-Type: application/json` — never HTML. This guards against a CloudFront CustomErrorResponses bug where errors were served as HTML instead of JSON.

**Test DB failsafe:** `src/test/global-setup.js` calls `assertTestDb()` — if the DB name doesn't end with `_test`, the suite aborts. All 14 tables are TRUNCATEd (cascade) at suite start.

**Regression tests (Playwright):** Lives in `testing/regression_testsuite/`. Runs against port 9001 (not 9000). Defaults to NonDB mode; set `REGRESSION_DB=1` to use a real DB.

### Deployment (AWS SAM)

Always deploy via `npm run deploy` — it gates on tests passing before building and deploying:

```bash
npm run deploy                              # tests → sam build → sam deploy → S3 sync → CF invalidate
sam build && sam deploy --config-env staging  # staging only
```

Never run `sam deploy` directly; the `npm run deploy` test gate is mandatory.

Secrets live in AWS Secrets Manager at `/<tenant>/<env>/<name>`:
- `jwt-secret`, `google-client-secret`, `origin-secret`
- `db-host`, `db-write-user`, `db-write-password`, `db-read-user`, `db-read-password`

Config (non-secret) lives in SSM Parameter Store: `google-client-id`, `db-host` (redundant), DB usernames.

### Infrastructure constraints

See `.project-constraints` — serverless-only (Lambda + API Gateway). No EC2, Docker, or containers. RDS/Aurora must never be publicly accessible; Lambda must reach the DB via VPC.

---

## Architecture

### Overview

Single Node/Express server (`server.js`, port 9000) serving both a REST API (`/api/*`) and static HTML frontend (`/frontend`). A GraphQL endpoint lives at `POST /graphql` (auth-gated). Unmatched routes fall back to `login.html`.

### Key files

| Purpose | Path |
|---------|------|
| Server entry point | `server.js` |
| PostgreSQL pool (dual read/write) | `backend/db.js` |
| NonDB mode middleware | `backend/middleware/nondb-mode.js` |
| Auth middleware (JWT) | `backend/middleware/auth.js` |
| File-based DB service | `backend/services/file-db-service.js` |
| Email (AWS SES) | `backend/services/ses.js` |
| Google OAuth (PKCE) | `backend/auth/google-auth.js` |
| GraphQL schema + resolvers | `backend/graphql/` |
| Frontend shared utilities | `frontend/js/platform.js` |
| DB schema | `database/schema.sql` |
| Table manifest for NonDB | `metadata/manifest.json` |
| AWS SAM template | `template.yaml` |

### Route structure

| Prefix | File | Auth required |
|--------|------|--------------|
| `/api/auth` | `backend/routes/auth.js` | Login/create-user are public; all others `requireAuth` |
| `/api/admin` | `backend/routes/admin.js` | `requireAdmin` or `requireSiteAdmin` |
| `/api/tenants` | `backend/routes/tenants.js` | `requireAuth` |
| `/api/subscriptions` | `backend/routes/subscriptions.js` | `requireAuth` |
| `/api/invoices` | `backend/routes/invoices.js` | `requireAuth` |
| `/api/enhancements` | `backend/routes/enhancements.js` | `requireAuth` |
| `/api/metrics` | `backend/routes/metrics.js` | `requireAuth` |
| `/api/contact` | `backend/routes/contact.js` | Public |
| `/api/site-config` | inline in `server.js` | Public |
| `/health` | inline in `server.js` | Public |
| `POST /graphql` | `backend/graphql/` | `requireAuth` |

### Dual-mode data layer (mandatory)

Every route must support both PostgreSQL and file-based (NonDB) mode. Check `req.db.mode` at the top of each handler:

```js
if (req.db.mode === 'nondb') {
    // use req.db.fileDb (FileDbService) — methods: find, getById, create, update, delete, count
} else {
    // use db (the imported pg pool wrapper) — db.query() auto-routes SELECT→read pool, writes→write pool
}
```

`backend/db.js` maintains separate write (max 10) and read (max 10) pools; `query()` inspects the SQL verb to route automatically (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/TRUNCATE → write pool; everything else → read pool).

When adding a new DB table:
1. Add `CREATE TABLE` to `database/schema.sql`
2. Add `metadata/<table>.schema.json`
3. Add `transactiondata/<table>.json` (empty array `[]`)
4. Add table name to `metadata/manifest.json`
5. Add NonDB branch to all route handlers for the new table

### API conventions

- **Versioning:** `Accept: application/json;v=1` header — never in the URL path
- **Auth:** `Authorization: Bearer <token>` — 15-min access tokens, 1-hr refresh tokens
- **Responses:** `{ success: true, data: ... }` for success, `{ error: "..." }` for errors
- **Origin protection:** `X-Origin-Secret` header (set via `ORIGIN_SECRET`) blocks direct API Gateway hits; `/health` and `/api/site-config` are exempt

### Auth & roles

`backend/middleware/auth.js` exports three guards:
- `requireAuth` — any valid JWT; attaches `req.staff` with `{ id, email, name, role, type }`
- `requireAdmin` — role must be `admin` or `site_admin`
- `requireSiteAdmin` — role must be `site_admin` only

Roles defined in `amr_roles`: `site_admin`, `admin`, `sales_manager`, `billing`, `staff`.

`POST /api/auth/create-user` is the first-time setup endpoint and requires `setup_key = AMRD_JWT_SECRET` in the body instead of a Bearer token.

### Auth flow (frontend)

- Login stores `amrd_token`, `amrd_refresh_token`, `amrd_staff` (JSON) in localStorage
- `platform.js` `apiFetch()` automatically refreshes the access token on 401 then retries
- 401/403 responses show an access-denied modal with a 10-second countdown, then redirect to `/login`
- 15-minute inactivity timeout is started automatically by `renderSidebar()` in `frontend/js/platform.js`; all protected pages call this — no extra work needed
- `POST /api/auth/create-user` requires `setup_key = AMRD_JWT_SECRET` (first-time setup only)

### Frontend

Static HTML pages in `frontend/`. Shared logic is in `frontend/js/platform.js`, which provides:
- `apiFetch(url, options)` — auth-aware fetch with auto token refresh and 401/403 modal
- `gqlFetch(query, variables)` — GraphQL helper
- `renderSidebar(config)` — builds navigation, starts session timeout, shows NonDB mode badge
- CSS injection for the admin UI (dark sidebar, cards, tables, modals)

The NonDB mode indicator (yellow badge) is injected by `renderSidebar` when the server sets the `X-DB-Mode: nondb` response header.

### Email (SES)

`backend/services/ses.js` sends via AWS SES. When `SES_FROM_EMAIL` is not set (local dev), it logs to stdout instead of sending. Requires IAM `ses:SendEmail` permission on the verified `amaradata.com` identity.

### Serverless deployment

- **Lambda** (`ApiFn`): 1 GB memory, 29 s timeout; wraps Express via `serverless-http`; HTTP API Gateway (not REST API) with basePath routing — Lambda handler strips the basePath prefix
- **Frontend**: S3 bucket behind CloudFront; CloudFront Function rewrites extensionless URLs to `.html`; Origin Access Control (OAC) restricts S3 access to CloudFront only
- **Logs**: one CloudWatch Log Group per tenant/env (e.g., `amaradata-prod`)
- **Cost tags**: all resources tagged `tenant`, `application`, `project`, `component`
