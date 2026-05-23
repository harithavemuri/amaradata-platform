const crypto = require('crypto');
const https  = require('https');

const pkceStore = new Map();

class GoogleOAuth {
    constructor() {
        this.clientId    = process.env.GOOGLE_CLIENT_ID;
        this.clientSecret= process.env.GOOGLE_CLIENT_SECRET;
        this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:9000/api/auth/google/callback';
        this.frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:9000').replace(/\/$/, '');

        if (!this.clientId)     throw new Error('GOOGLE_CLIENT_ID is not set');
        if (!this.clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not set');
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

    async exchangeCode(code, codeVerifier) {
        const body = new URLSearchParams({
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            code,
            grant_type:    'authorization_code',
            redirect_uri:  this.redirectUri,
            code_verifier: codeVerifier,
        }).toString();

        const data = await this._request({
            hostname: 'oauth2.googleapis.com',
            path:     '/token',
            method:   'POST',
            headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, body);

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
