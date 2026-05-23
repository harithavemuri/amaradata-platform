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
- `window.__amrd` is the only global — no other globals

## Testing

- TDD: Red → Green → Refactor
- Framework: Vitest + jsdom
- Unit tests cover route logic, FileDbService operations, and auth token handling

## Deployment

- Serverless-only (see .project-constraints)
- `sam build && sam deploy` for production
- All environments (prod, staging) are isolated CloudFormation stacks
