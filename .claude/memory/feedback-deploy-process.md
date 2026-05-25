---
name: feedback-deploy-process
description: "Always run tests before deploying amaradata — use npm run deploy, never bare sam deploy"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c7bd7a7f-1b10-49eb-a541-c6cf2dc5f239
---

## Rule: Always run tests before deploying

Use `npm run deploy` (not bare `sam build && sam deploy`). The deploy script runs tests first and aborts if they fail.

```bash
# Correct — tests gate the deploy
npm run deploy

# Wrong — skips tests
sam build && sam deploy
```

**Why:** The "Unexpected token '<', <!DOCTYPE" login error was caused by a silent regression (CloudFront x-origin-secret header being wiped). Tests in `src/test/auth-routes.test.js` catch this class of issue before it hits production.

**How to apply:** Every time I issue a deploy command for amaradata-platform, use `npm run deploy`. If I need to deploy without tests (e.g. emergency), I must explicitly tell the user I'm skipping tests and why.

[[feedback-aws-infra-standards]]
