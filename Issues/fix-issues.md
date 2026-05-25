# Fix Issues Skill — Reference

Skill lives at: `.claude/skills/fix-issues.md`
Invoke with: `/fix-issues` in Claude Code

## CSV format

Input columns: `Issueid, Report Date, Notes, Task Type, Site Name, Tenant Name, Apply Fix?, Fixed?`

- `Task Type = Task` → always **enhancement** (billable)
- `Task Type = Bug` → **bug** (not billable) unless Notes describe new functionality → **enhancement** (billable)
- `Tenant Name` → used by the AmaraData Enhancements screen to auto-match the tenant on upload

## What it does

1. Reads `Issues/RohasTestNotesSheet.csv`
2. For every row where **Apply Fix? = Yes** and **Fixed?** is blank:
   - Classifies as **Bug** (not billable) or **Enhancement** (billable to tenant)
   - Applies the fix to the project named in **Site Name**
   - Writes `C:\Haritha\github\rohas-group\src\test\issues\issue-<N>.test.js`
   - Runs `npx vitest run` on that file
   - Sets **Fixed? = Yes** if test passes, `No – <error>` if it fails
3. Writes `Issues/RohasTestNotesSheet_Fixed.csv` with columns:
   `Issueid, Report Date, Notes, Site Name, Apply Fix?, Fixed?, Fix Details, Type, Billable`
4. Prints a summary table

## Billing logic

- **Bug** → `Type=bug`, `Billable=No` — no charge to tenant
- **Enhancement** → `Type=enhancement`, `Billable=Yes` — tenant is billed

## DB table

The output CSV is designed to be uploaded to AmaraData and imported into the `issue_fixes` table:

```sql
-- amaradata-platform database
issue_fixes(id, tenant_id, issue_id, report_date, site_name, notes,
            apply_fix, fixed, fix_details, item_type, is_billable,
            billing_amount, billed_at, invoice_id, created_at, updated_at)
```

Upload endpoint (to be built): `POST /api/issue-fixes/import` — accepts the CSV, upserts rows by `(tenant_id, issue_id)`.

## Run all issue tests at once

```bash
cd C:\Haritha\github\rohas-group
npx vitest run src/test/issues/
```
