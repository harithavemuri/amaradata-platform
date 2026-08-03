---
name: project-shared-db-bootstrap-script
description: scripts/bootstrap-shared-db-infrastructure.js is the reproducible record of the manually-created shared Aurora cluster — must be updated whenever that infra changes outside a SAM template.
metadata:
  type: project
---

`scripts/bootstrap-shared-db-infrastructure.js` (`npm run bootstrap-db-infra`) in amaradata-platform documents and idempotently reproduces the shared Aurora Serverless v2 Postgres cluster (`amaradata`) used by both amaradata-platform and rohas-group.

**Why it exists:** The cluster was created manually via a direct `aws rds create-db-cluster` CLI call (confirmed via CloudTrail, invoked by IAM user "haritha"), not through either app's SAM stack — both run with `CreateDbCluster=false` and just reference it externally via SSM/Secrets Manager. Before this script, there was no reproducible record of how to rebuild it if ever needed. User explicitly asked for this to be written and kept current.

**How to apply:** Whenever making an out-of-band change to the shared DB infrastructure — cluster/instance settings, parameter group values (like the `idle_in_transaction_session_timeout`/`statement_timeout` added in the 2026-08-02 RDS-cost investigation), a new tenant's database/role, scaling config, security group, subnet group — update this script's `CONFIG`/`PARAMETER_GROUP`/`TENANTS` block in the same change, not as a follow-up. The script is idempotent and safe to re-run at any time to verify it still matches reality (every step checks-before-creating; it never resets an existing role's password). Related: [[feedback-least-privilege-credential-checks]] (the script only touches the master password for its own legitimate administrative purpose — creating new roles — and never prints it).
