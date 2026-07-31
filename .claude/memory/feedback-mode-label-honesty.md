---
name: feedback-mode-label-honesty
description: Never label a DB-mode test run as bare "db" — this codebase's DB-mode test/load/throughput paths are all safety-guarded to the _test database, so the honest label is "regressiondb"; reserve "db" for a real/live database, even if that path isn't currently reachable
metadata:
  type: feedback
---

The user caught `testing/performance-testdata/*.json`'s `mode` field showing `"nondb"`/`"db"` and pointed out this was misleading: `"db"` implies a real/live database, but every DB-mode path in this codebase's test infrastructure (`playwright.config.js`'s `REGRESSION_DB=1`, `playwright.config.load-test.js`, `scripts/run-throughput-test.js --mode db`) is hard-guarded by `global-setup.js` to only ever run against the `_test`-suffixed database — it can never actually be a live DB today.

**Fix:** `helpers/perf-aggregate.js`'s `resolveReporterMode(dbModeEnabled, testDbName)` now resolves three states instead of a boolean-derived two: `nondb` (file-based), `regressiondb` (DB mode, name ends in `_test` — the only reachable case), `db` (DB mode, name does NOT end in `_test` — not reachable via the current safety guard, but a correct label to have ready rather than silently mislabeling a live DB as `regressiondb` if that guard is ever loosened). Wired into both `playwright.config.js` and `playwright.config.load-test.js`'s reporter option, and into `run-throughput-test.js`'s console log line (same conflation existed there too, unprompted — found by grepping for the same pattern elsewhere after the first fix, not because the user pointed at it directly).

**Why this matters generally, not just for this one field:** any status/mode label that's derived from a *static config flag* rather than *what was actually targeted* risks this exact honesty gap. When adding a similar label anywhere (test mode, environment tag, deployment stage), prefer deriving it from the real resource being hit (e.g. actual DB name, actual URL) over a boolean that only indirectly implies it.

**How to apply:** if a new script or config gets its own DB-mode toggle, route its display/report label through `resolveReporterMode` (or the same resolution logic) rather than hardcoding `'db'`. Grep for `'db' : 'nondb'`-shaped ternaries or `${MODE} mode`-style bare interpolation when auditing for this pattern — that's exactly how the `run-throughput-test.js` instance was found.
