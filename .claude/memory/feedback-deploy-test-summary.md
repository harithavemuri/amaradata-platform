---
name: feedback-deploy-test-summary
description: Before recommending a deploy, always show pass/fail counts for every test layer (unit, integration, E2E, smoke)
metadata:
  type: feedback
---

Before recommending or approving a deploy, always report a test results summary broken down by pyramid layer, showing passed and failed counts for each type.

**Required format before any deploy recommendation:**

| Layer | Tests | Passed | Failed |
|-------|-------|--------|--------|
| Unit | N | N | N |
| Integration (DB) | N | N | N |
| Integration (NonDB) | N | N | N |
| E2E (Playwright) | N | N | N |
| Smoke (prod) | N | N | N |

Only recommend deploying when all layers show 0 failures.

**Why:** The user wants full visibility into test health at every layer before committing a deploy. A single failing test in any layer — even smoke — should block the deploy recommendation.

**How to apply:** After running `npm test`, `npm run test:regression`, and any smoke checks, compile actual pass/fail numbers from the output before saying "ready to deploy" or suggesting `npm run deploy`. If any layer wasn't run, call that out explicitly rather than assuming it passed.
