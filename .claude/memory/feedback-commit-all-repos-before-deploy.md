---
name: feedback-commit-all-repos-before-deploy
description: "Commit (and push) every repo with changes (amaradata-platform, tenant-group, amaradata-portal) BEFORE deploying; and follow each repo's own deploy memory — supersedes the old \"commit only amaradata-platform\" rule (2026-10-04)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: c61243fe-6fd0-450c-a40f-f08177d9e2e3
  modified: 2026-10-04T23:09:10.682Z
---

Before any production deploy, **every repo with changes gets committed and pushed first** — `amaradata-platform`, `tenant-group` (the rohas-group repo; branch `master`), and `amaradata-portal` — never deploy code that only exists in a working tree.

**Why:** On 2026-10-04 I deployed `tenant-group` to `rohas-prod` with 87 uncommitted files, because an older rule ([[feedback-amaradata-repo-commits-only]]) said never to commit there. User: "Why is code not in git. You need to commit all repos before deploy." That explicit instruction replaces the old rule.

**How to apply:** commit + push all repos that have changes before running a deploy (leave out test churn like `.tmp-nondb-testdata/`, `testing/testdata/`, and unrelated untracked files — say what was left out). Then follow the repo's own deploy memory (tenant-group keeps these in `tenant-group/.claude/memory/`; read them, don't rely on this summary):
- **Ask which local tenants to smoke-test and which tenants to deploy, every single deploy** (`feedback_deploy_tenant_confirmation`) — never default to rohas. tenant-group stacks: `rohas-prod`, `cloud-prod`, each a separate `node scripts/deploy.js --tenant <t> --stack-name <t>-prod`.
- **Even when told "deploy", pause for a final go-ahead** (`feedback_no_auto_deploy`), and ask whether to deploy now or keep stacking work (`feedback_dont_assume_deploy_timing`).
- **Annotated git tag first**, pushed, then deploy (`feedback_release_tagging`) — tenant-group's deploy.js does NOT tag; amaradata-platform's does.
- **`npm run deploy` only** (`feedback_deploy_gate`). tenant-group's `deploy.js` has **no `--dry-run`** (it forwards the flag to `sam deploy`, after a real `sam build`) — amaradata-platform's and the portal's do.
- Kill stale servers on port 8002 before trusting Playwright (`feedback_stale_server_port_8002`) — `reuseExistingServer: true` reuses a dev server on the real local DBs.
- After a deploy: verify the actual content landed, not just HTTP 200 (`feedback_verify_deploy_content_not_just_status`), and do the security pass unprompted (`feedback_post_deploy_security_check`; same rule in the portal).
- If a background deploy gets killed, check CloudFormation state directly (`feedback_background_task_kills`). The intermittent `npm test` exit 127 / flaky failure is known (`feedback_npm_test_chain_flakiness`).
- Portal: `npm run deploy` / `deploy:dry-run`, stack `amaradata-ownerportal-prod`; its tests share the platform's `_test` DB — never run concurrently.
