const crypto  = require('crypto');
const https   = require('https');
const secrets = require('../services/secrets');

// Resolved at runtime through services/secrets.js, not baked into the Lambda
// env at deploy time (see project-realtime-secret-fetch-standard.md).
const GOOGLE_CLIENT_SECRET_ID = process.env.GOOGLE_CLIENT_SECRET_ID;

const pkceStore = new Map();

class GoogleOAuth {
    constructor() {
        this.clientId    = process.env.GOOGLE_CLIENT_ID;
        this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:9000/api/auth/google/callback';
        this.frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:9000').replace(/\/$/, '');

        if (!this.clientId) throw new Error('GOOGLE_CLIENT_ID is not set');
        // clientSecret is resolved lazily in exchangeCode() — a constructor can't
        // be async, and this class is instantiated fresh per request anyway.
    }

    generatePKCE() {
        const codeVerifier  = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        return { codeVerifier, codeChallenge };
    }

    generateState()     { return crypto.randomBytes(16).toString('hex'); }
    generateSessionId() { return crypto.randomBytes(16).toString('hex'); }

    createAuthUrl(state, codeChallenge) {
        const params = new URLSearchParams({
            client_id:             this.clientId,
            redirect_uri:          this.redirectUri,
            response_type:         'code',
            scope:                 'openid email profile',
            state,
            code_challenge:        codeChallenge,
            code_challenge_method: 'S256',
            access_type:           'offline',
            prompt:                'consent',
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    storePKCE(sessionId, data) {
        pkceStore.set(sessionId, { ...data, ts: Date.now() });
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [k, v] of pkceStore) { if (v.ts < cutoff) pkceStore.delete(k); }
    }

    getPKCE(sessionId) {
        const d = pkceStore.get(sessionId);
        if (!d) return null;
        if (Date.now() - d.ts > 10 * 60 * 1000) { pkceStore.delete(sessionId); return null; }
        return d;
    }

    _request(opts, body = null) {
        return new Promise((resolve, reject) => {
            const req = https.request(opts, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(raw)); }
                    catch { reject(new Error('Invalid JSON from Google')); }
                });
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    async _exchangeWith(clientSecret, code, codeVerifier) {
        const body = new URLSearchParams({
            client_id:     this.clientId,
            client_secret: clientSecret,
            code,
            grant_type:    'authorization_code',
            redirect_uri:  this.redirectUri,
            code_verifier: codeVerifier,
        }).toString();

        return this._request({
            hostname: 'oauth2.googleapis.com',
            path:     '/token',
            method:   'POST',
            headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, body);
    }

    async exchangeCode(code, codeVerifier) {
        let clientSecret = await secrets.getSecret(GOOGLE_CLIENT_SECRET_ID, { fallback: process.env.GOOGLE_CLIENT_SECRET });
        let data          = await this._exchangeWith(clientSecret, code, codeVerifier);

        // invalid_client is what Google returns for a wrong client secret — could
        // be a genuinely wrong value, or this instance's cache being stale mid a
        // rotation. One retry with a freshly fetched secret costs little either way.
        if (data.error === 'invalid_client') {
            secrets.invalidate(GOOGLE_CLIENT_SECRET_ID);
            clientSecret = await secrets.getSecret(GOOGLE_CLIENT_SECRET_ID, { fallback: process.env.GOOGLE_CLIENT_SECRET });
            data          = await this._exchangeWith(clientSecret, code, codeVerifier);
        }

        if (data.error) throw new Error(data.error_description || data.error);
        return data;
    }

    async getUserInfo(accessToken) {
        const data = await this._request({
            hostname: 'www.googleapis.com',
            path:     '/oauth2/v2/userinfo',
            method:   'GET',
            headers:  { Authorization: `Bearer ${accessToken}` },
        });
        if (data.error) throw new Error(data.error?.message || 'Failed to get user info');
        return data;
    }
}

module.exports = GoogleOAuth;
