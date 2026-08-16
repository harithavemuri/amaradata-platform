const db       = require('../db');
const FileDbService = require('../services/file-db-service');
const dbHealth = require('../services/db-health');

let _fileDb;
function getFileDb() {
    if (!_fileDb) _fileDb = new FileDbService();
    return _fileDb;
}

// Logged per-request (not just once on activation) — the user wants to build
// a CloudWatch alarm on the volume of NonDB-mode traffic per hour, which
// needs one log line per request, filterable/countable by event name and by
// `reason` (explicit "env" config vs an automatic "db_unavailable" fallback).
function activateNonDb(req, res, reason) {
    console.warn(JSON.stringify({ level: 'WARN', event: 'nondb_request', reason, method: req.method, path: req.path }));
    req.db = { mode: 'nondb', reason, fileDb: getFileDb() };
    res.setHeader('X-DB-Mode', 'nondb');
    res.setHeader('X-DB-Mode-Reason', reason);
}

module.exports = function nondbMode(req, res, next) {
    if (process.env.NONDB_MODE === 'true') {
        activateNonDb(req, res, 'env');
        return next();
    }

    // Automatic fallback: only ever driven by services/db-health.js's
    // circuit breaker, which itself is only ever tripped by a genuine DB
    // connectivity error (see backend/db.js) — never by a query error, an
    // auth failure, or any other kind of DB problem.
    if (!dbHealth.shouldTryDb()) {
        activateNonDb(req, res, 'db_unavailable');
        return next();
    }

    req.db = { mode: 'db', query: db.query.bind(db) };
    next();
};
