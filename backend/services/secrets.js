/**
 * Cached AWS Secrets Manager reader.
 *
 * Why this exists: DB passwords used to be baked into Lambda env vars by
 * CloudFormation's {{resolve:secretsmanager:...}} at deploy time, which meant a
 * rotated secret had no effect until the next deploy — rotating a live secret
 * would break every running app until someone redeployed. Reading at runtime
 * instead lets a rotation take effect on its own, within one cache TTL.
 *
 * Caching is not just a latency optimization — GetSecretValue bills per API
 * call, and the pg pools ask for a password on every new connection, so an
 * uncached read would put a metered AWS call on a hot path.
 *
 * Deliberately resilient rather than strict: a Secrets Manager outage or throttle
 * must never take the database down, so a stale cached value is preferred over an
 * error, and an env-var fallback keeps local dev / NonDB mode / tests working with
 * no AWS credentials at all.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { value: string, expiresAt: number }>} */
const _cache = new Map();

/**
 * Fetches currently in flight, keyed by secret id.
 *
 * Without this, an auth-failure invalidation under load would have every waiting
 * connection issue its own GetSecretValue at the same instant — one billed API
 * call per connection, exactly when the system is already struggling. Concurrent
 * misses share a single call instead.
 *
 * @type {Map<string, Promise<string>>}
 */
const _inflight = new Map();

let _client = null;

function _ttlMs() {
    // Read per-call, not once at module load — tests and Lambda config can change it.
    const raw = parseInt(process.env.SECRET_CACHE_TTL_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function _getClient() {
    // Lazy: constructing the client eagerly would make this module require AWS
    // credentials just to be imported, breaking local dev and unit tests.
    if (!_client) {
        const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
        _client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    }
    return _client;
}

/**
 * Fetch a secret's string value, served from cache when fresh.
 *
 * @param {string|undefined} secretId       Secrets Manager id/ARN. Falsy → fallback, no AWS call.
 * @param {{ fallback?: string }} [options] fallback is used when secretId is unset or the fetch fails.
 * @returns {Promise<string>}
 */
async function getSecret(secretId, options = {}) {
    const { fallback } = options;

    // Not configured to use Secrets Manager for this value — caller supplied a
    // plain env var instead. This is the local-dev and pre-migration path.
    if (!secretId) {
        if (fallback !== undefined) return fallback;
        throw new Error('getSecret: no secretId and no fallback provided');
    }

    const cached = _cache.get(secretId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Join an in-flight fetch rather than starting a competing one. A rejected
    // fetch is never left in the map, so the next caller retries instead of
    // inheriting a stuck failure.
    let pending = _inflight.get(secretId);
    if (!pending) {
        pending = _fetchAndCache(secretId).finally(() => _inflight.delete(secretId));
        _inflight.set(secretId, pending);
    }

    try {
        return await pending;
    } catch (e) {
        // Never log the secret itself — only its id and the failure reason.
        console.error(`[secrets] failed to fetch ${secretId}: ${e.message}`);

        // A stale password is far more likely to still be valid than not, and
        // beats refusing every DB connection until Secrets Manager recovers.
        if (cached) {
            console.warn(`[secrets] serving stale cached value for ${secretId}`);
            return cached.value;
        }
        if (fallback !== undefined) return fallback;
        throw e;
    }
}

async function _fetchAndCache(secretId) {
    const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const res   = await _getClient().send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = (res.SecretString || '').trim();
    _cache.set(secretId, { value, expiresAt: Date.now() + _ttlMs() });
    return value;
}

/**
 * Drop one cached secret, forcing the next read to refetch.
 *
 * This is the rotation recovery hook: backend/db.js calls it when Postgres
 * rejects a password, so a rotation takes effect on the very next query instead
 * of waiting out the cache TTL.
 */
function invalidate(secretId) {
    _cache.delete(secretId);
}

/** Drop all cached values — used by tests, and after a deliberate rotation. */
function clearCache() {
    _cache.clear();
    _inflight.clear();
}

module.exports = { getSecret, invalidate, clearCache };
