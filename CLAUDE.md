# AmaraData Platform — Developer Guide

## Setup

```bash
npm install
cp .env.example .env        # fill in DB credentials and JWT secret
psql -U postgres -d amaradata_platform -f database/schema.sql
npm run dev
# → http://localhost:9000
```

## NonDB mode (no database required)

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

## CLI

```bash
node scripts/cli.js export-db [tables]   # DB → JSON files
node scripts/cli.js serve-nondb          # start in file-based mode
node scripts/cli.js check-db             # test DB connectivity
node scripts/cli.js stats                # row counts per table
node scripts/cli.js sync [--dry-run]     # JSON files → DB
```

## API conventions

- **Versioning:** `Accept: application/json;v=1` header — never in the URL path
- **Auth:** `Authorization: Bearer <token>` — 15-min access tokens, 1-hr refresh tokens
- **Responses:** `{ success: true, data: ... }` for success, `{ error: "..." }` for errors

## Dual-mode data layer (mandatory)

Every route must support both PostgreSQL and file-based (NonDB) mode. Check
`req.db.mode` at the top of each handler and branch accordingly:

```js
if (req.db.mode === 'nondb') {
    // use req.db.fileDb (FileDbService)
} else {
    // use db (the imported pg pool wrapper)
}
```

When adding a new DB table:
1. Add `CREATE TABLE` to `database/schema.sql`
2. Add `metadata/<table>.schema.json`
3. Add `transactiondata/<table>.json` (empty array `[]`)
4. Add table name to `metadata/manifest.json`
5. Add NonDB branch to all route handlers for the new table

## Auth flow

- Login → returns `token` (15 min) + `refresh_token` (1 hr)
- Client stores both in localStorage (`amrd_token`, `amrd_refresh_token`)
- `platform.js` auto-refreshes the access token on 401 before retrying
- 15-minute inactivity timeout triggers automatic logout (built into `renderSidebar`)
- `POST /api/auth/create-user` requires `setup_key = AMRD_JWT_SECRET` (first-time setup only)

## Session timeout

The 15-minute inactivity timer is started automatically by `renderSidebar()` in
`frontend/js/platform.js`. All protected pages already call this, so no extra work is needed.

## Deployment (AWS SAM)

```bash
# First time
sam deploy --guided

# Subsequent deploys
sam build && sam deploy

# Staging
sam build && sam deploy --config-env staging
```

Secrets live in AWS Secrets Manager at `/<tenant>/<env>/<name>`:
- `jwt-secret`
- `db-host`, `db-write-user`, `db-write-password`, `db-read-user`, `db-read-password`

## Infrastructure constraints

See `.project-constraints` — serverless-only deployment, AWS SAM required.
No EC2, Docker, or containers.

## Testing

```bash
npm test          # run once
npm run test:watch  # watch mode
```

Tests use Vitest + jsdom. Setup: `src/test/setup.js`.
