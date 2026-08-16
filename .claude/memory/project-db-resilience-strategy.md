---
name: project-db-resilience-strategy
description: DB reads auto-retry through connectivity errors, writes fail fast with a dbUnavailable-flagged 503 instead of retrying — implemented in backend/db.js + backend/services/http-errors.js
metadata:
  type: project
---

`backend/db.js`'s `query()` splits retry behavior by read vs write when the DB is down or Aurora is warming up from scale-to-zero:
- **Reads** (routed to `readPool`): wrapped in `withConnectRetry` (`backend/services/db-retry.js`, previously only used by the `DBInitFn`/`DBMigrateFn` Lambdas) — transparent retry with linear backoff (3 attempts, 5s/10s) through a connectivity error, so a brief hiccup never surfaces to the caller.
- **Writes** (routed to `writePool`): never auto-retried on a connectivity error — the write's outcome is unknown, so a blind retry risks double-applying it (see [[feedback-idempotent-writes]] for why it's still safe to ask the *caller* to retry). Instead the error is re-thrown flagged `err.dbUnavailable = true` with a clean message, original preserved as `err.cause`.

`backend/services/http-errors.js` — `sendError(res, err, tag, fallbackMessage?)` is the shared route catch-block helper: responds `503 { error: 'Service temporarily unavailable — please retry shortly.' }` when `isDbUnavailable(err)`, else the existing generic `500` (or a route's custom fallback message, e.g. auth.js's forgot/reset-password routes). Wired into all 9 `backend/routes/*.js` files' DB-call catch blocks, `backend/graphql/resolvers.js` (reads only — swapped from a direct `readPool.query()` bypass to `db.query()` so it gets the same retry), and `server.js`'s fallback Express error handler.

**Why:** User requested this exact behavior — "reads still work, writes politely fail with a retry-later message" during a rare DB-down/warm-up window — rather than reviving NonDB (file-based) mode as a fallback, which was a separate, much larger removal effort in progress at the time.

**Superseded/extended:** the "rather than reviving NonDB mode as a fallback" call above was later reversed — [[project-nondb-auto-fallback]] adds automatic NonDB-mode fallback for **reads only** once a real connectivity error is detected, layered on top of (not replacing) everything in this file. Writes are completely unaffected: they still always attempt the real DB and still get the exact `dbUnavailable`-503 behavior described here, never silently rerouted to NonDB mode.

**How to apply:** Any new write endpoint should go through `db.query()` (never call `writePool.query`/`readPool.query` directly) and use `sendError()` in its catch block, not a hand-rolled 500 — that's how it inherits this behavior automatically. Existing idempotency of writes is what makes telling the client "retry" safe — see [[feedback-idempotent-writes]].

Tests: `testing/unittests/unit/db-query-resilience.test.js` — covers read-retries-and-succeeds, write-fails-fast-with-dbUnavailable-and-no-retry, write-passes-through-non-connectivity-errors-unchanged, and `sendError`'s 503-vs-500 branching. **Gotcha:** `vi.mock('pg', ...)` does NOT intercept `db.js`'s internal `require('pg')` (same CJS-require gotcha as `auth-secret-retry.test.js` vs `services/secrets.js`) — mock by requiring the real `db.js` module and overwriting `.query` directly on the `writePool`/`readPool` instances it exports, not by mocking the `pg` package. Also: `testing/unittests/setup.js` sets `NONDB_MODE=true` globally, which trips `db.js`'s own top-of-file short-circuit stub — unset it before `require()`-ing `db.js` in a test that needs the real pool code path, restore after.
