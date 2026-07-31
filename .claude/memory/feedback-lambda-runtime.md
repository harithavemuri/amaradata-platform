---
name: feedback-lambda-runtime
description: Lambda runtime must always be nodejs22.x — Node.js 20.x is end-of-life for AWS account 797666412164
metadata:
  type: feedback
---

Always use `Runtime: nodejs22.x` (or the latest active LTS) for all AWS Lambda functions in this project. Never use `nodejs20.x` or any older runtime.

**Why:** AWS sent an end-of-life notice for Node.js 20.x on account 797666412164 (the same account both amaradata-platform and rohas-group deploy to — visible in amaradata's `FrontendBucket` name `amrd-platform-amaradata-prod-797666412164`). Using EOL runtimes triggers AWS compliance warnings and eventually blocks deployment.

**How to apply:** Any time a Lambda function is added or `template.yaml` is modified, ensure `Runtime: nodejs22.x` in `Globals.Function` and any per-function overrides (`ApiFn`, `DBInitFn`, `DBMigrateFn`). amaradata-platform's `template.yaml` is currently compliant (`nodejs22.x` in Globals) — this rule is about not regressing it when the template changes.
