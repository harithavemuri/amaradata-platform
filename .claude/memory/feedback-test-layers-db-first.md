---
name: feedback-test-layers-db-first
description: amaradata-platform must maintain 5 test layers (unit, API/integration, Playwright regression, release-tracking, smoke), and DB-mode tests always run before NonDB-mode tests in every suite that has both
metadata:
  type: feedback
---

**Two permanent rules, both user-mandated:**

1. **DB-mode tests always run before NonDB-mode tests**, in every suite that has both — `npm test` (DB → NonDB → unittests), `npm run test:regression:all` (DB → NonDB), and any new combined script. Never reorder this, even for convenience.
2. **Maintain 5 test layers**, mirroring rohas-group's structure:
   - **Unit** — `testing/unittests/unit/` — pure logic, no HTTP/DB/filesystem beyond a throwaway temp dir.
   - **API/integration** — `src/test/*.test.js` + `testing/unittests/{api,integration}`.
   - **Playwright regression** — `testing/regression_testsuite/`.
   - **Release-tracking** — `testing/release-tracking/checks/TC-*.spec.js`, one check per historically-fixed issue, indexed in `release-test-map.json`.
   - **Smoke** — `scripts/smoke-prod.js`, read-only checks against a live URL.

**Why:** User explicitly asked to "fulfill the testing needs... always run the dbmode tests first... run unit tests, api tests, playwright tests, release-tracking tests, smoke tests similar to rohas-group" and to remember this permanently. Before this, `npm run deploy` actually ran NonDB regression *before* DB regression (backwards), `testing/unittests/` had no `unit/` subfolder, and `testing/release-tracking/` was completely empty — all fixed the same session this rule was recorded.

**How to apply:**
- When adding any new test-running script (package.json or otherwise), put DB-mode before NonDB-mode in the sequence.
- When adding a new pure-logic module (parsing, token handling, isolated services), add its test under `testing/unittests/unit/`, not `api`/`integration`.
- When a production bug gets fixed, consider adding a `TC-<n>-*.spec.js` under `testing/release-tracking/checks/` — see [[feedback-test-data-prefix]] for cleanup convention, and note these checks target a local isolated NonDB server by default (`PW_BASE_URL` overrides to a real environment).
- `npm run test:all` is the single command that runs all 5 layers, DB-mode-first throughout.
