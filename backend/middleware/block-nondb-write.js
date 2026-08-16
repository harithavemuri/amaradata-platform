/**
 * NonDB mode is read-only. Every route that mutates data (POST/PUT/PATCH/
 * DELETE) inserts this before its handler instead of branching internally on
 * req.db.mode === 'nondb' the way GET handlers still do — see
 * project-nondb-read-only.md.
 *
 * Exception: auth.js's plain login (and the Google OAuth exchange's
 * existing-user path) update last_login_at as a bookkeeping side effect of
 * signing in, not a "data write" in the sense this blocks — those routes
 * don't use this middleware.
 *
 * Unconditional regardless of *why* req.db.mode is 'nondb' — a write must
 * never reach file storage whether that's explicit NONDB_MODE=true config or
 * nondb-mode.js's automatic db_unavailable fallback (services/db-health.js).
 * Only the response shape differs: a real DB outage gets the same 503
 * dbUnavailable shape every other write failure in this codebase uses
 * (services/http-errors.js) instead of the structural "read-only" 403, which
 * would misleadingly imply a permanent policy rather than a temporary outage.
 */
function blockNonDbWrite(req, res, next) {
    if (req.db.mode === 'nondb') {
        if (req.db.reason === 'db_unavailable') {
            return res.status(503).json({ error: 'Service temporarily unavailable — please retry shortly.' });
        }
        return res.status(403).json({ error: 'NonDB mode is read-only — writes are not supported.' });
    }
    next();
}

module.exports = { blockNonDbWrite };
