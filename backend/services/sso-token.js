const crypto = require('crypto');

// Shared HMAC-signed compact-JWT minting for AmaraData's role as SSO issuer —
// used both by the human-browser POST /api/auth/sso/issue route and by
// backend/services/tenant-sso-client.js's server-to-server calls into a
// tenant's admin API, so there's exactly one place that defines the token
// shape tenant sites (rohas-group's AuthSsoFn) verify against.
function signSsoToken(secret, { aud, sub, name, role, ttlSeconds = 60 }) {
    const now     = Math.floor(Date.now() / 1000);
    const payload = { iss: 'amaradata', aud, sub, name, role, iat: now, exp: now + ttlSeconds };
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig     = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
}

module.exports = { signSsoToken };
