---
name: feedback-deploy-process
description: "Block production deploys if any test fails; run smoke tests automatically after every deployment"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c7bd7a7f-1b10-49eb-a541-c6cf2dc5f239
---

## Rule 1: Block deployments to production if any tests are failing

**User explicitly asked to permanently remember this.** No deploy to production (or any environment) may proceed if any tests fail.

Use `npm run deploy` (not bare `sam build && sam deploy`). The deploy script runs the full test suite first and aborts if any test fails.

```bash
# Correct — tests gate the deploy, aborts on any failure
npm run deploy

# Wrong — skips tests entirely
sam build && sam deploy
```

This applies to all test types:
- Unit tests (`npm test` / vitest)
- Playwright regression tests (NonDB + DB mode)

**Why:** The "Unexpected token '<', <!DOCTYPE" login error was caused by a silent regression (CloudFront x-origin-secret header being wiped). Tests in `src/test/auth-routes.test.js` catch this class of issue before it hits production. User explicitly mandated this gate after that incident.

**How to apply:** Every time I issue a deploy command for amaradata-platform, use `npm run deploy`. There are NO exceptions — even for urgent fixes, run tests first. If the user explicitly instructs skipping tests, I must warn them and document why.

## Rule 2: Run smoke tests automatically after every deployment

**User explicitly asked to permanently remember this.** After ANY deployment — backend Lambda, frontend S3/CloudFront, API Gateway, or infrastructure — automatically run the production smoke test:

```bash
SMOKE_TEST_USER=smoketest.admin SMOKE_TEST_ADMIN_PASSWORD=<password> node scripts/smoke-prod.js
```

This applies to ALL deployment components:
- Backend (Lambda / API) deployment
- Frontend (S3 sync / CloudFront invalidation)
- Infrastructure changes (template.yaml / SAM)
- Any combination of the above

**Why:** User mandated automatic post-deploy verification. The smoke test catches CloudFront routing failures, broken auth, missing GET handlers, and version drift that only manifest in the live environment.

**How to apply:** After `npm run deploy` completes, always run the smoke test. If the smoke test fails, treat it as a deployment failure and investigate before declaring the deploy done.

## Rule 3: Always run smoke tests in DB mode first, then NonDB mode

**User-mandated order.** When running smoke tests, always run DB mode first, then NonDB mode:

```bash
# DB mode first
SMOKE_URL=http://localhost:9000 SMOKE_TEST_USER=smoketest.admin SMOKE_TEST_ADMIN_PASSWORD=<pw> npm run smoke

# NonDB mode second
NONDB_MODE=true npm run dev  # start nondb server, then:
SMOKE_URL=http://localhost:9000 SMOKE_TEST_USER=smoketest.admin SMOKE_TEST_ADMIN_PASSWORD=<pw> npm run smoke
```

**Why:** DB mode tests validate schema and SQL; NonDB mode tests validate the file-based code paths. DB goes first because it catches migration/schema issues that would mask NonDB bugs.

**How to apply:** Every invocation of smoke tests — post-deploy, after fixes, as part of verification — must run DB mode first, then NonDB mode. Never reverse the order.

## Rule 4: Always run Playwright regression tests in DB mode first, then NonDB mode

**User-mandated order.** When running Playwright regression tests, always run DB mode first, then NonDB mode:

```bash
# DB mode first
REGRESSION_DB=1 npm run test:regression

# NonDB mode second (default)
npm run test:regression
```

**Why:** Same rationale as smoke tests — DB mode validates schema-dependent UI flows; NonDB mode validates the file-based fallback paths.

**How to apply:** Every invocation of Playwright regression tests must run DB mode first, then NonDB mode.

[[feedback-aws-infra-standards]]
