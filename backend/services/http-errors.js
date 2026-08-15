/**
 * Shared error -> HTTP response translation for route catch blocks.
 *
 * backend/db.js marks a write that failed on a DB connectivity issue with
 * `err.dbUnavailable = true` instead of throwing the raw pg error. That gets
 * a distinct 503 with a retry-friendly message here; everything else keeps
 * the existing generic 500 (raw DB/internal errors must never reach the
 * frontend — see feedback-no-db-errors-to-frontend.md).
 */
function isDbUnavailable(err) {
    return !!(err && err.dbUnavailable);
}

function sendError(res, err, tag, fallbackMessage = 'Internal server error') {
    console.error(tag, err.message);
    if (isDbUnavailable(err)) {
        return res.status(503).json({ error: 'Service temporarily unavailable — please retry shortly.' });
    }
    res.status(500).json({ error: fallbackMessage });
}

module.exports = { isDbUnavailable, sendError };
