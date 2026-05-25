# Memory Index

> **Canonical location:** This folder is git-tracked at `.claude/memory/` in the amaradata-platform repo. A copy also lives at the per-machine harness path (`~/.claude/projects/C--Haritha-github-amaradata-platform/memory/`) so context auto-loads. When updating a memory, update **both** locations.

- [rohas-group Tech Stack](rohas-group-tech-stack.md) — Full tech stack for rohas-group: Node/Express, PostgreSQL, Vite, Google OAuth, AWS SAM/Lambda, dual-mode data layer
- [rohas-group Implementation Patterns](rohas-group-impl-patterns.md) — File/folder conventions, naming, route/service/frontend patterns, session handling, role system
- [rohas-group Constraints & Rules](rohas-group-constraints.md) — Hard constraints: serverless-only, spec-driven dev, dual-mode data layer, AWS services whitelist
- [AmaraData Production Domain](project-amaradata-domain.md) — Production URL is https://amaradata.com (apex domain, not platform.amaradata.com)
- [DB Security Rule](feedback-db-security.md) — RDS/Aurora must NEVER be publicly accessible; Lambda must use VPC to reach DB (both amaradata + rohas-group)
- [AWS Infra Standards](feedback-aws-infra-standards.md) — Always apply cost-allocation tags (tenant/application/project/component); 1 consolidated log group per application
- [Deploy Process](feedback-deploy-process.md) — Always use `npm run deploy` (tests gate the deploy); never bare `sam deploy`
- [NonDB No AWS](feedback-nondb-no-aws.md) — NonDB mode must have ZERO AWS RDS/DynamoDB (no database AWS services); other AWS (SES, S3, SSM) are allowed; both sites
- [Auth Error UX](feedback-auth-error-ux.md) — 401/403 must show access-denied popup with 10-sec countdown then redirect to login (both sites)
- [Issue Fixes → Enhancements](project-issue-fixes-table.md) — issue_fixes retired; CSV import goes into enhancements table (source='csv'); bugs=not billable, enhancements=billable
