# AmaraData Platform — Development Constitution

## Code Quality

- No ORM — direct parameterized SQL via `pg`
- No magic dynamic SQL construction on untrusted input — validate before interpolating column names
- Every route must have both DB and NonDB branches (see CLAUDE.md)
- API versioning via Accept header only: `Accept: application/json;v=1`
- Short JWTs: 15-min access, 1-hr refresh — no long-lived tokens

## Security

- Passwords hashed with bcrypt (cost 12)
- JWT HS256 with secret from environment — never hardcoded
- All secrets in AWS Secrets Manager in production
- No sensitive data (passwords, secrets) returned in API responses
- Parameterized queries only — no string interpolation of user input into SQL
- CORS restricted to FrontendUrl in production

## Data Layer

- Dual-mode is mandatory: every data operation must work in both DB and NonDB mode
- FileDbService API: `find`, `getById`, `create`, `update`, `delete`, `count`
- Schema definitions in `metadata/*.schema.json`; data in `transactiondata/*.json`
- `metadata/manifest.json` lists all tables — keep it in sync

## Frontend

- Vanilla CSS only — no CSS framework
- All API calls use `Accept: application/json;v=1` header
- 15-minute inactivity session timeout is non-negotiable
- `window.__amrd` is the primary global for page-facing API (e.g. `window.__amrd.logout()`); `frontend/js/platform.js` also sets `window.__amrdToggleSidebar` as a second, internal-use global for the sidebar's collapse/expand toggle — not page-facing API, but a real second global nonetheless

## Testing

- TDD: Red → Green → Refactor
- Framework: Vitest + jsdom
- Unit tests cover route logic, FileDbService operations, and auth token handling

## Deployment

- Serverless-only (see .project-constraints)
- `npm run deploy` (`scripts/deploy.js`) for production — never `sam deploy` directly. It is a phase runner, not an npm `&&` chain: each phase spawns its real command (`npx`/`node`/`sam`/`aws`) directly rather than nesting another `npm run`, to avoid a flaky intermediate-npm-process failure mode seen on this machine and in the sibling `rohas-group` repo
- The full test gate (unit, integration DB+NonDB, regression DB+NonDB, release-tracking) must pass before `sam build`/`sam deploy` run — there is deliberately no flag to skip it
- After `sam deploy`: DB migration is invoked, DB-password rotation is attached to any newly eligible secrets, frontend syncs to S3, CloudFront is invalidated, then a post-deploy smoke test runs
- DB role passwords are read from AWS Secrets Manager at request time (not baked into Lambda env vars at deploy time) and are cached with a short TTL, so a rotated password takes effect within one cache window instead of requiring a redeploy; rotation itself is on-demand only (`aws secretsmanager rotate-secret`), never automatic on a schedule
- All environments (prod, staging) are isolated CloudFormation stacks
