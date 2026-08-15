/**
 * Recovery from a password rotation that happens mid-flight.
 *
 * Rotating a DB password does not disturb connections that are already open —
 * Postgres leaves authenticated sessions alone on ALTER ROLE — so a rotation is
 * invisible until the pool needs to open a *new* connection. That one is created
 * with whatever password services/secrets.js still has cached, and fails
 * authentication until the cache TTL lapses.
 *
 * Rather than wear those errors for the rest of the TTL window, an auth failure
 * is treated as evidence that the cached password is stale: drop it, refetch,
 * and try once more.
 */

// SQLSTATEs Postgres returns for a bad credential. 28P01 is the one a rotated
// password actually produces; 28000 covers the broader authorization-failure
// class the driver can surface in the same situation.
const AUTH_ERROR_CODES = new Set(['28P01', '28000']);

/** @param {any} err @returns {boolean} */
function isAuthError(err) {
    return !!err && AUTH_ERROR_CODES.has(err.code);
}

/**
 * Run a DB operation, recovering once from a stale cached password.
 *
 * Exactly one retry: if the freshly fetched password also fails, the credential
 * is genuinely wrong (role revoked, secret pointing at the wrong user) and must
 * surface as an error instead of retrying in a loop.
 *
 * @template T
 * @param {() => Promise<T>} run            The DB call to attempt.
 * @param {() => void|Promise<void>} onAuthFailure  Invalidates the cached password.
 * @returns {Promise<T>}
 */
async function withAuthRetry(run, onAuthFailure) {
    try {
        return await run();
    } catch (err) {
        if (!isAuthError(err)) throw err;

        console.warn('[db] authentication failed — assuming a rotated password, refetching');
        await onAuthFailure();
        return await run();
    }
}

/**
 * Recovery from a cold/unreachable DB at connect time.
 *
 * The shared Aurora Serverless v2 cluster can take up to ~30s to resume from a
 * scale-to-zero pause, so a connection attempt that lands during that window
 * fails with a network-level error rather than a real, permanent problem —
 * DBInitFn (backend/lambda/db-init.js) and DBMigrateFn (backend/lambda/db-migrate.js)
 * both hit this. A bounded number of retries with backoff is what recovers it.
 *
 * Distinct from isAuthError/withAuthRetry above: a rotated password must never
 * be retried as if Aurora were merely asleep, and a cold-start timeout must
 * never be treated as a credential problem, so the two classifiers do not overlap.
 */

const CONNECTIVITY_ERROR_CODES = new Set([
    'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
]);

const CONNECTIVITY_MESSAGE_PATTERNS = [/connection terminated/i, /timeout expired/i];

/** @param {any} err @returns {boolean} */
function isConnectivityError(err) {
    if (!err) return false;
    if (CONNECTIVITY_ERROR_CODES.has(err.code)) return true;
    const message = String(err.message || '');
    return CONNECTIVITY_MESSAGE_PATTERNS.some((re) => re.test(message));
}

/**
 * Run a DB operation, retrying with linear backoff while the failure looks
 * like Aurora being asleep rather than a real error.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} run   The DB call to attempt (1-indexed attempt number).
 * @param {{
 *   retries?: number,
 *   delayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onRetry?: (err: any, attempt: number) => void,
 * }} [options]
 * @returns {Promise<T>}
 */
async function withConnectRetry(run, options = {}) {
    const {
        retries = 3,
        delayMs = 5000,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onRetry,
    } = options;

    let attempt = 0;
    for (;;) {
        attempt++;
        try {
            return await run(attempt);
        } catch (err) {
            if (!isConnectivityError(err) || attempt >= retries) throw err;

            if (onRetry) onRetry(err, attempt);
            await sleep(delayMs * attempt);
        }
    }
}

module.exports = {
    isAuthError, withAuthRetry, AUTH_ERROR_CODES,
    isConnectivityError, withConnectRetry, CONNECTIVITY_ERROR_CODES,
};
