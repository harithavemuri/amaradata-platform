---
name: project-realtime-secret-fetch-standard
description: All secret fetches in amaradata-platform must use runtime fetch+cache with auth-failure cache refresh, not CFN-baked env vars — user-mandated standing rule
metadata:
  type: project
---

Every place in amaradata-platform that consumes an AWS Secrets Manager secret must fetch it at runtime through `backend/services/secrets.js`'s `getSecret(secretId, { fallback })` (TTL-cached, in-flight-fetch-deduped) rather than relying on a value CloudFormation baked into the Lambda's environment once at deploy time via `{{resolve:secretsmanager:...}}`. When a runtime auth/verification failure looks like it could be caused by a stale cached secret, the caller must invalidate the cache (`secrets.js`'s `invalidate(secretId)`) and retry once — the same routine `backend/services/db-retry.js`'s `withAuthRetry` already implements for the DB pools in `backend/db.js`.

**Why:** a `{{resolve:secretsmanager:...}}`-baked env var has no effect from a rotation until the next deploy — rotating a live secret breaks every running invocation until someone redeploys. This is explicitly why `backend/services/secrets.js` and `backend/services/db-retry.js` were built (see [[project-shared-db-bootstrap-script]] and the DB-password-rotation work). The user confirmed on 2026-08-11 that this pattern should extend to every secret fetch in the codebase, not just DB passwords.

**Known constraint, not an oversight:** `DBMigrateFn` (`backend/lambda/db-migrate.js`) is VPC-attached (Aurora access) with no NAT Gateway or Secrets Manager VPC interface endpoint in `template.yaml` — confirmed by grep, zero `AWS::EC2::VPCEndpoint` resources exist. It has no network path to the Secrets Manager API and must keep reading its master password from the CFN-resolved env var unless/until such an endpoint is added. Don't convert VPC-attached functions to a runtime `GetSecretValueCommand` call without first checking they have a route to Secrets Manager (either non-VPC, or a VPC endpoint exists) — same check needed for any future VPC-attached Lambda.

**How to apply:** when adding a new secret-consuming code path or auditing an existing one in amaradata-platform, check whether it (a) already goes through `secrets.js`/`db-retry.js`, (b) reads a CFN-baked env var directly (drift to fix, if the function is not VPC-constrained), or (c) is VPC-attached with no Secrets Manager route (legitimate exception — leave as env var, note why). rohas-group is a separate codebase; this rule was stated for amaradata-platform specifically and hasn't been confirmed for rohas-group.
