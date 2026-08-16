/**
 * Circuit breaker driving automatic NonDB-mode fallback purely from real DB
 * connectivity failures — never from any other kind of DB error (a bad query,
 * a constraint violation, a stale rotated password) and never proactively.
 * backend/db.js calls markDown()/markUp() only around genuine
 * isConnectivityError() cases (see services/db-retry.js); everything else is
 * left to surface through the existing generic-500 / dbUnavailable-503 paths
 * unchanged.
 *
 * Lambda-compatible by design: no background timer (a setInterval prober
 * would not reliably fire between frozen Lambda invocations). Instead this is
 * a lazy, request-driven "half-open" breaker — once the cooldown window has
 * elapsed, the next incoming request is simply routed to DB mode as a trial;
 * if it fails, markDown() is called again and the window restarts.
 */

const RECHECK_COOLDOWN_MS = (() => {
    const raw = parseInt(process.env.DB_HEALTH_RECHECK_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 15000;
})();

let healthy   = true;
let downSince = 0;

/**
 * Record a real DB connectivity failure. Always logs — every occurrence,
 * whether it's the transition from healthy to down or a repeat while already
 * down (e.g. a failed half-open trial) — per the standing rule that these
 * errors must be logged no matter what, so a CloudWatch alarm can be built on
 * them.
 */
function markDown(err) {
    console.error(JSON.stringify({
        level: 'ERROR',
        event: 'db_connectivity_error',
        message: err && err.message,
        code: err && err.code,
        wasHealthy: healthy,
    }));
    healthy   = false;
    downSince = Date.now(); // always refreshed — a repeat failure restarts the cooldown window
}

/** Record a successful DB call. No-ops quietly if already healthy. */
function markUp() {
    if (!healthy) {
        console.warn(JSON.stringify({ level: 'WARN', event: 'db_recovered', downForMs: Date.now() - downSince }));
    }
    healthy   = true;
    downSince = 0;
}

/**
 * Whether a request should attempt the real DB: yes if nothing's wrong, or if
 * enough time has passed since the last known failure to justify a fresh
 * trial. False means the caller should route this request to NonDB mode
 * instead (see backend/middleware/nondb-mode.js).
 */
function shouldTryDb() {
    return healthy || (Date.now() - downSince >= RECHECK_COOLDOWN_MS);
}

function getStatus() {
    return { healthy, downSince: downSince || null };
}

module.exports = { markDown, markUp, shouldTryDb, getStatus };
