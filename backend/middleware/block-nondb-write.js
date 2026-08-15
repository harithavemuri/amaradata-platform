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
 */
function blockNonDbWrite(req, res, next) {
    if (req.db.mode === 'nondb') {
        return res.status(403).json({ error: 'NonDB mode is read-only — writes are not supported.' });
    }
    next();
}

module.exports = { blockNonDbWrite };
