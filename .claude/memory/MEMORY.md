# Memory Index

> **Canonical location:** This folder is git-tracked at `.claude/memory/` in the amaradata-platform repo. A copy also lives at the per-machine harness path (`~/.claude/projects/C--Haritha-github-amaradata-platform/memory/`) so context auto-loads. When updating a memory, update **both** locations.

- [rohas-group Tech Stack](rohas-group-tech-stack.md) — Full tech stack for rohas-group: Node/Express, PostgreSQL, Vite, Google OAuth, AWS SAM/Lambda, dual-mode data layer
- [rohas-group Implementation Patterns](rohas-group-impl-patterns.md) — File/folder conventions, naming, route/service/frontend patterns, session handling, role system
- [rohas-group Constraints & Rules](rohas-group-constraints.md) — Hard constraints: serverless-only, spec-driven dev, dual-mode data layer, AWS services whitelist
- [AmaraData Production Domain](project-amaradata-domain.md) — Production URL is https://amaradata.com (apex domain, not platform.amaradata.com)
- [DB Security Rule](feedback-db-security.md) — RDS/Aurora must NEVER be publicly accessible; Lambda must use VPC to reach DB (both amaradata + rohas-group)
- [AWS Infra Standards](feedback-aws-infra-standards.md) — Always apply cost-allocation tags (tenant/application/project/component); 1 consolidated log group per application
- [Deploy Process](feedback-deploy-process.md) — Block deploys if any test fails; run smoke tests after every deployment (backend/UI/API); always `npm run deploy` (user-mandated permanent rules)
- [NonDB No AWS](feedback-nondb-no-aws.md) — NonDB mode must have ZERO AWS RDS/DynamoDB (no database AWS services); other AWS (SES, S3, SSM) are allowed; both sites
- [Auth Error UX](feedback-auth-error-ux.md) — 401/403 must show access-denied popup with 10-sec countdown then redirect to login (both sites)
- [Issue Fixes → Enhancements](project-issue-fixes-table.md) — issue_fixes retired; CSV import goes into enhancements table (source='csv'); bugs=not billable, enhancements=billable
- [DB Queries Backend Only](feedback-db-queries-backend-only.md) — DB queries must NEVER run from frontend JS; all DB access is in backend/routes/*.js only
- [No DB Errors to Frontend](feedback-no-db-errors-to-frontend.md) — Raw DB/internal errors must NEVER reach the frontend; log to CloudWatch, return generic 500 message
- [Case-Insensitive Search](feedback-case-insensitive-search.md) — All text-field DB queries use lower(col)=lower($N); NonDB uses .toLowerCase() on both sides; passwords excluded (user-mandated)
- [Date Display Format](feedback-date-format.md) — All frontend dates must show as "Mon DD YYYY" (e.g. "May 01 2026"); use fmtDate helper; never .slice(0,10) or raw epoch numbers
- [Testing Pyramid](feedback-testing-pyramid.md) — Tests must follow unit > integration > E2E > smoke pyramid; warn when a request would place tests at a higher layer than necessary
- [Deploy Test Summary](feedback-deploy-test-summary.md) — Before recommending a deploy, always show pass/fail counts per layer (unit, integration DB, integration NonDB, E2E, smoke)
- [Performance SLA](feedback-performance-sla.md) — API ≤500ms, page load ≤3s; API perf tests at integration layer, page load perf tests at E2E layer
- [Tenant Onboarding](project-tenant-onboarding.md) — rohas-group is the only tenant so far; new tenants = new repo modeled on rohas-group, ask which features to enable, bill per enabled feature
- [No Auto-Deploy](feedback-no-auto-deploy.md) — never deploy to AWS automatically; stop at commit, wait for explicit "deploy" (both rohas-group + amaradata)
- [American English](feedback-american-english.md) — all copy uses American spelling (Organization, Color, Analyze...) — both repos
- [Lambda Runtime](feedback-lambda-runtime.md) — always nodejs22.x; nodejs20.x is EOL on AWS account 797666412164 (shared account)
- [Release Tagging](feedback-release-tagging.md) — annotated git tag (match package.json version), pushed, before every production deploy
- [No Raw Client Errors](feedback-no-raw-client-errors.md) — frontend catch blocks must never show raw JS/fetch exceptions either; generic message + console.error
- [Test Data Prefix](feedback-test-data-prefix.md) — any record created in prod for testing/verification must have its identifier prefixed "zzzzzz"
- [Overloaded Term Reconfirm](feedback-overloaded-term-reconfirm.md) — when a request reuses a term that already names a shipped feature/field, ask which meaning is intended before assuming
- [Test Layers + DB-First](feedback-test-layers-db-first.md) — DB-mode tests always run before NonDB in every suite; maintain 5 layers (unit, API/integration, Playwright regression, release-tracking, smoke) mirroring rohas-group
- [TDD Always](feedback-tdd-always.md) — write the failing test before implementation code, for every change (new features too, not just fixes) — both repos
- [Testing Parity Increment 2](project-testing-parity-increment2.md) — smoke lifecycle, deploy wiring, edit-save Playwright coverage, role matrix, perf SLA; real bugs found (== vs ===, role name regex, empty amr_roles, tenants pollution)
- [Verify Exit Codes](feedback-verify-exit-codes.md) — never trust a piped command's exit code (`cmd | tail`); redirect to a file and check its actual content before declaring pass/fail
- [Performance Framework](project-performance-framework.md) — rohas-style perf-benchmark history + load test + throughput test built for amaradata; skipped DB-time breakdown (no per-request hook) and interactive deploy-gate (not requested); real load-test duration bug found and fixed
- [Playwright Nested-Describe Login](feedback-playwright-nested-describe-login.md) — never nest a describe that logs in as a different user inside one that already logs in; nested beforeEach hooks share one page, login.html's already-logged-in redirect breaks the second login
- [Mode Label Honesty](feedback-mode-label-honesty.md) — test-mode labels must be 3-way (nondb/regressiondb/db) derived from the actual DB name targeted, never a bare db/nondb flag — regressiondb = _test DB, db = live DB (not currently reachable, guarded), nondb = files
- [Verify Before Responding](feedback-verify-before-responding.md) — never answer a diagnostic question with an assumed/inferred reason; gather direct evidence (screenshots, logs, live checks) first, then respond
- [Least-Privilege Credential Checks](feedback-least-privilege-credential-checks.md) — never retrieve/print root or write-level credentials during investigation; use the lowest-privilege credential that proves the point (e.g. read user rules out network issues)
- [Shared DB Bootstrap Script](project-shared-db-bootstrap-script.md) — scripts/bootstrap-shared-db-infrastructure.js reproduces the manually-created shared Aurora cluster; keep it updated whenever that infra changes outside a SAM template
- [Amaradata Repo Commits Only](feedback-amaradata-repo-commits-only.md) — never git commit/push in rohas-group, even when investigating/fixing something there; only amaradata-platform gets committed to
