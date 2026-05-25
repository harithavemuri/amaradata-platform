---
name: project-issue-fixes-table
description: Issue fix tracking is stored in the enhancements table (source='csv'), not a separate issue_fixes table. Bugs=not billable, enhancements=billable.
metadata:
  type: project
---

Issue fix data from the `/fix-issues` skill CSV is stored in the `enhancements` table in amaradata-platform, **not** a separate `issue_fixes` table (that table was retired and removed from the schema).

**Why:** User decided both manual enhancement work and CSV-imported issue fixes serve the same billing purpose — work done for a tenant. One table, one screen.

**How to apply:**
- CSV import endpoint: `POST /api/enhancements/import` — upserts by `(tenant_id, issue_id)`
- Tenant resolved automatically from the `Tenant Name` column in the CSV; fallback dropdown available
- `source='csv'` distinguishes imported rows from manually logged work (`source='manual'`)
- `item_type='bug'` → `is_billable=false`; `item_type='enhancement'` → `is_billable=true`
- Upload via the Enhancements screen (↑ Upload CSV button) — visible to all admins
- Extra columns added to `enhancements` for CSV rows: `source, issue_id, site_name, fixed, item_type, is_billable, report_date`
- The `issue_fixes` name still appears in the skill description but refers to data now stored in `enhancements`

Related: [[project-amaradata-domain]]
