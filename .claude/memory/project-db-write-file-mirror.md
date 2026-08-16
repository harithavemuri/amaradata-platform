---
name: project-db-write-file-mirror
description: In DB mode, every successful write also re-syncs its table's transactiondata/<table>.json — implemented in backend/db.js as a full-table re-SELECT after the write
metadata:
  type: project
---

`backend/db.js`'s `query()` mirrors every successful DB-mode write (INSERT/UPDATE/DELETE on a table listed in `metadata/manifest.json`) back to `transactiondata/<table>.json`, so those files stay current without a manual `npm run export-db`.

**Design:** rather than patching just the changed row(s) in from a `RETURNING` clause (many writes in this codebase don't use `RETURNING` at all — e.g. plain `DELETE`s), it re-reads the *whole* table (`SELECT * FROM <table> ORDER BY id`, same query `jobs/export-db-to-files.js`'s `exportTable()` already uses) and overwrites the JSON file. Self-correcting and handles INSERT/UPDATE/DELETE uniformly with one code path — trade-off is one extra `SELECT *` per write. Mirror failures (`fs.writeFileSync` errors, etc.) are logged and swallowed, never turned into a failure response for a write that already succeeded in the DB — the DB is always the source of truth.

Not mirrored: schema DDL (`CREATE`/`DROP`/`ALTER`/`TRUNCATE` — `writeTargetTable()` only matches `INSERT INTO`/`UPDATE`/`DELETE FROM`) and any table not in `metadata/manifest.json`'s list. A `TRUNCATE` (e.g. the test-suite's per-run reset) leaves the JSON file stale until the next real write on that table.

**Why:** User request — DB-mode writes should "write to files also as usual" (i.e. keep `transactiondata/` mirroring what NonDB mode's own writes already produce there), separate from the NonDB-mode-removal idea that was dropped ([[feedback-idempotent-writes]]/[[project-db-resilience-strategy]] context).

**Gotcha (already fixed, but re-check if this regresses):** `src/test/setup.js` (the DB-mode integration test entry point, `npm run test:db`) did **not** redirect `TRANSACTIONDATA_DIR` before this feature existed — every write in those tests would otherwise have overwritten the real, committed `transactiondata/*.json` files at the repo root. Fixed by adding `process.env.TRANSACTIONDATA_DIR = 'testing/testdata';` there, matching the convention `testing/unittests/setup.js` already used. If a new DB-mode test entry point is ever added, it needs the same redirect before requiring `backend/db.js`.

Tests: `testing/unittests/unit/db-query-resilience.test.js`'s "write-to-file mirror" block — mocks `backend/db.js`'s pool `.query` (not `pg` itself, same CJS-require gotcha as elsewhere) and points `TRANSACTIONDATA_DIR` at a `fs.mkdtempSync` scratch dir before requiring `db.js` (module-load-time constant, must be set first).

**On-demand full sync (super_admin UI):** `db.js` exports `mirrorTableToFile(table)` (resolves with the row count written) specifically so `POST /api/admin/sync-from-db` (admin.js route, `requireSuperAdmin`) can loop every `metadata/manifest.json` table and re-export all of them at once, rather than waiting for the next incidental write to each. Button: **"⇅ Sync from DB"** on `frontend/admin-health.html` (hidden in NonDB mode).

**The files→DB direction was removed entirely** (`POST /api/admin/sync-to-db`, `GET /api/admin/sync-status`, and the old topbar "⇅ Sync to DB" button in `frontend/js/platform.js` + its `PAGE_TABLES` visibility map — all deleted). User's reasoning: NonDB mode is meant to be read-only going forward, so `transactiondata/*.json` should only ever be a DB-derived mirror (this write-mirror feature, or the on-demand sync-from-db button above), never a source of truth pushed back into the DB. **`sync-from-db` is now the only sync direction — DB→files only.**

**Note — not yet done:** removing sync-to-db does not itself make NonDB mode's own write endpoints (every route's `req.db.fileDb.create/update/delete` branch) read-only or reject writes. Those branches are untouched and still function exactly as before; "read mode" is the stated intent behind removing the sync-back mechanism, not something enforced at the route level yet. If NonDB writes need to actually be blocked, that's a separate follow-up.

**Fallout fixed in the same change:** `scripts/seed-enhancements.js --target=production --yes` used to push a locally-regenerated `transactiondata/enhancements.json` to prod via `sync-to-db` (and required commit+deploy first before the sync would see the new data — see the old CLAUDE.md wording). Reworked to skip the file round-trip entirely: it now reads the same sibling-repo CSVs `jobs/sync-tenant-fixes.js` scans (via that job's newly-exported `findResultCsvs`, plus its existing `parseCsv`/`extractEligibleRows`/`groupByTenant`), groups rows by tenant, and POSTs each tenant's rows straight to the already-existing `POST /api/enhancements/import` (same route the Enhancements screen's CSV importer and `sync-tenant-fixes.js`'s own DB-mode path already use) — no intermediate file, no deploy-then-sync two-step. Without `--yes` it's a dry-run printing row counts per tenant.
