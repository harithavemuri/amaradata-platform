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

module.exports = { isAuthError, withAuthRetry, AUTH_ERROR_CODES };
