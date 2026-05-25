---
name: rohas-group-constraints
description: "Hard constraints and development rules for rohas-group from .project-constraints, CLAUDE.md, and specs/constitution.md"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c1e1427-c1f7-485b-ab1f-578630994161
---

## Hard Infrastructure Constraints (.project-constraints)
- **SERVERLESS ONLY** — no EC2, Docker, ECS, EKS, containers, or traditional servers
- Allowed AWS services: Lambda, API Gateway, RDS Serverless, S3, CloudFront, DynamoDB, Cognito, Step Functions
- Deployment must use AWS SAM, CloudFormation, or Serverless Framework

## Dual-Mode Data Layer (mandatory)
- Every route must support both PostgreSQL and file-based JSON (NonDB mode)
- Check `req.db.mode` and branch accordingly in all route handlers
- When adding a new DB table: update SQL schema → export to `metadata/` → add sample data → update export job → update `metadata/manifest.json`

**Why:** Offline/disconnected operation is a first-class requirement; file-based mode is the fallback, not an afterthought.

**How to apply:** Never write a route handler that only works with PostgreSQL. Always implement the NonDB branch.

## Spec-Driven Development
- All features defined in `specs/` before implementation
- `specs/constitution.md` — code quality, testing, security, accessibility principles
- `specs/project-spec.md` — authoritative feature list (27KB)
- Use Speckit CLI for development workflow

## API Versioning Rule
- Use Accept header (`Accept: application/json;v=1`), NOT URL versioning (`/api/v1/`)

## Session & Security Rules
- 15-minute inactivity timeout on all protected pages
- JWT access tokens expire in 15 minutes; refresh tokens in 1 hour
- PKCE required for OAuth flow (state + code_verifier)
- Secrets in AWS Secrets Manager at `/<tenant>/<env>/<secret-name>` — never hardcoded

## Multi-Tenant Deployment
- One CloudFormation stack per tenant+env: `rohas-prod`, `rohas-staging`
- Isolated Secrets Manager paths per tenant

## Frontend Rules
- Sidebar rendered at `</body>` via `window.__sidebar.render('nav_key')`
- Session timeout script included on every authenticated page
- Shared utilities must be IIFE scripts (no global leakage)
- No CSS framework — vanilla CSS with CSS variables only
- Brand palette strictly enforced: Black, White, Gold, Dark Blue

## Google OAuth PKCE pattern (rohas-group → amaradata-platform)
Flow: POST /api/auth/google/login → store PKCE in in-memory Map → redirect to Google → GET /api/auth/google/callback → redirect to login.html?code&state&session_id → POST /api/auth/google/exchange → return JWT pair.
- No axios — use Node.js built-in `https` module
- Frontend stores `oauth_session` in sessionStorage during the OAuth round-trip
- Falls back to browser-supplied code_verifier if server-side PKCE session expired

## Site-config / env var pattern (rohas-group → amaradata-platform)
- Never hardcode company info, contact details, or gallery images in HTML
- Expose GET /api/site-config returning all public config from process.env
- Frontend fetches /api/site-config on DOMContentLoaded for gallery + contact info
- GALLERY_IMAGES in .env is a JSON array; falls back to hardcoded default if missing
