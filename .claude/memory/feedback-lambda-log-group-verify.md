---
name: feedback-lambda-log-group-verify
description: Never assume a Lambda's CloudWatch log group is the AWS default — check its actual LoggingConfig first
metadata:
  type: feedback
---

Before reading or reasoning about a Lambda's CloudWatch logs, always check that Lambda's actual configured log group first (`aws lambda get-function-configuration --function-name <fn> --query LoggingConfig`, or the `LoggingConfig` block in `template.yaml`) — never assume the AWS default `/aws/lambda/<function-name>`.

**Why:** amaradata-platform's `template.yaml` sets a custom shared `LogGroup: !Sub '${Tenant}-${Env}'` (e.g. `amaradata-prod`) on at least `ApiFn`, consolidating logs per tenant/env rather than one group per function (see [[feedback-aws-infra-standards]] — "1 consolidated log group per application"). Assuming the default log-group name would silently look at the wrong (likely empty/nonexistent) log stream and produce a confidently wrong diagnosis. The user has called this out as a repeated assumption to stop making.

**How to apply:** Whenever a task involves inspecting/reasoning from a specific Lambda's logs (debugging a failure, verifying a fix, checking whether an error actually occurred) — for any Lambda in amaradata-platform or rohas-group — read that function's real `LoggingConfig`/`LogGroup` from `template.yaml` or a live `get-function-configuration` call before querying CloudWatch. Applies to per-function log groups too, not just the shared one — don't assume even when a function *doesn't* have an explicit override, since siblings in the same template may differ.
