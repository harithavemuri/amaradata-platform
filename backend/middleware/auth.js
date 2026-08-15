const jwt     = require('jsonwebtoken');
// Accessed via the module object (secrets.getSecret(...)), not destructured,
// so tests can overwrite secrets.getSecret/secrets.invalidate on the shared
// module object and have that actually take effect here — a destructured
// local binding would keep pointing at the original function instead.
const secrets = require('../services/secrets');

// Resolved at runtime through services/secrets.js's cache, not baked into the
// Lambda env at deploy time (see project-realtime-secret-fetch-standard.md) —
// a rotated JWT secret now takes effect within one cache TTL instead of
// requiring a redeploy. With no AMRD_JWT_SECRET_ID set, getSecret() falls
// straight through to AMRD_JWT_SECRET (local dev / tests / not-yet-migrated
// environments) and never calls AWS.
const JWT_SECRET_ID = process.env.AMRD_JWT_SECRET_ID;

function getJwtSecret() {
    return secrets.getSecret(JWT_SECRET_ID, { fallback: process.env.AMRD_JWT_SECRET });
}

/**
 * Verify a JWT, retrying once with a freshly fetched secret if verification
 * fails. Different concurrent Lambda execution environments each hold their
 * own independent secret cache, so a token minted by an instance that has
 * already picked up a rotation can fail to verify on one still holding the
 * old value — indistinguishable, from here, from a genuinely bad token. One
 * retry recovers the former cheaply; a token that still doesn't verify after
 * refetching is the latter.
 */
async function verifyWithRetry(token) {
    try {
        return jwt.verify(token, await getJwtSecret());
    } catch {
        secrets.invalidate(JWT_SECRET_ID);
        return jwt.verify(token, await getJwtSecret());
    }
}

async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = await verifyWithRetry(token);
        if (payload.type === 'refresh') return res.status(401).json({ error: 'Use access token' });
        req.staff = payload;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

async function requireAdmin(req, res, next) {
    return requireAuth(req, res, () => {
        if (!['admin', 'site_admin'].includes(req.staff.role))
            return res.status(403).json({ error: 'Admin only' });
        next();
    });
}

async function requireSiteAdmin(req, res, next) {
    return requireAuth(req, res, () => {
        if (req.staff.role !== 'site_admin')
            return res.status(403).json({ error: 'Site admin only' });
        next();
    });
}

async function sign(payload) {
    return jwt.sign({ ...payload, type: 'access' }, await getJwtSecret(), { expiresIn: '15m' });
}

async function signRefresh(payload) {
    return jwt.sign({ ...payload, type: 'refresh' }, await getJwtSecret(), { expiresIn: '1h' });
}

async function verifyRefresh(token) {
    const payload = await verifyWithRetry(token);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');
    return payload;
}

module.exports = {
    requireAuth, requireAdmin, requireSiteAdmin,
    sign, signRefresh, verifyRefresh,
    getJwtSecret, verifyWithRetry,
};
