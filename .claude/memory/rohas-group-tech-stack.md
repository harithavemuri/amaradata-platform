---
name: rohas-group-tech-stack
description: "Full tech stack for the rohas-group project — languages, frameworks, DB, cloud, auth, testing, deployment"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c1e1427-c1f7-485b-ab1f-578630994161
---

## Runtime & Languages
- Node.js 18+ (backend), JavaScript ES6+ and partial TypeScript (frontend)
- SQL (PostgreSQL), HTML5/CSS3/vanilla JS (frontend pages)

## Backend
- Express.js (local dev server, simulates Lambda locally)
- AWS Lambda (Node.js 22.x, arm64, 512 MB, 29s timeout) for production
- GraphQL read-only API at `/graphql`
- REST API — no URL versioning; uses `Accept: application/json;v=1` header

## Frontend
- Vite (build tool + dev server on port 8000, proxies to backend on 8002)
- Standalone HTML pages at root level + React components in `src/pages/`
- Vanilla CSS with CSS variables; no CSS framework (no Bootstrap, Tailwind)
- Brand colors: Black `#000000`, White `#FFFFFF`, Gold `#C9A227`/`#D4AF37`, Dark Blue `#1E3A5F`
- Shared utilities as IIFE scripts in `src/utils/` (window.__sidebar, window.__impersonation, window.__sessionLogout)

## Database
- PostgreSQL (primary) — direct SQL via `pg`, no ORM
- Read/write connection pool separation (readPool + writePool; SELECTs auto-route to read pool)
- File-based JSON fallback (NonDB mode): `metadata/*.schema.json` + `transactiondata/*.json`
- Multi-tenant: shared `rohas_tenant` DB + per-project DBs (e.g., `amaracasa`)

## Authentication
- Google OAuth 2.0 with PKCE flow
- JWT HS256: 15-min access tokens, 1-hour refresh tokens
- Session stored in localStorage: `token`, `role`, `userInfo`, `groups`
- 15-minute inactivity timeout (session-timeout.js)

## Cloud & Deployment
- AWS SAM (CloudFormation) — stack per tenant+env, e.g. `rohas-prod`
- Lambda + API Gateway + Aurora Serverless v2 + S3 + CloudFront
- Secrets in AWS Secrets Manager at `/<tenant>/<env>/<secret-name>`
- SSM Parameter Store for non-secret config
- **Serverless-only**: no EC2, Docker, containers, or traditional servers

## Testing
- Vitest + jsdom (browser simulation)
- TDD methodology; test setup in `src/test/setup.js`

## Dev Tools
- Speckit (spec-driven development CLI)
- ESLint, dotenv, nodemon
- CLI scripts: `node scripts/cli.js export-db | serve-nondb | check-db | stats | sync`
- Git hooks: `scripts/setup-git-hooks.bat` (Windows) / `.sh` (Mac/Linux)

## Key Config Files
- `template.yaml` — SAM CloudFormation template
- `samconfig.toml` — SAM CLI profiles (prod/staging)
- `vite.config.js` — Vite dev server config
- `.env.example` — PostgreSQL mode vars
- `.env.nondb.example` — file-based mode vars
