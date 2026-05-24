const router                              = require('express').Router();
const bcrypt                              = require('bcryptjs');
const crypto                              = require('crypto');
const db                                  = require('../db');
const { sign, signRefresh, verifyRefresh, requireAuth } = require('../middleware/auth');
const GoogleOAuth                         = require('../auth/google-auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    try {
        if (req.db.mode === 'nondb') {
            const users = req.db.fileDb.find('amr_users').filter(u => u.email === email && u.is_active);
            const user  = users[0];
            if (!user || !(await bcrypt.compare(password, user.password_hash)))
                return res.status(401).json({ error: 'Invalid credentials' });
            req.db.fileDb.update('amr_users', user.id, { last_login_at: new Date().toISOString() });
            const safe = { id: user.id, email: user.email, name: user.name, role: user.role };
            return res.json({ success: true, token: sign(safe), refresh_token: signRefresh(safe), user: safe });
        }
        const { rows } = await db.query(
            'SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [email]
        );
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash)))
            return res.status(401).json({ error: 'Invalid credentials' });
        await db.query('UPDATE amr_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        const safe = { id: user.id, email: user.email, name: user.name, role: user.role };
        res.json({ success: true, token: sign(safe), refresh_token: signRefresh(safe), user: safe });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
    try {
        const payload = verifyRefresh(refresh_token);
        const safe    = { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
        res.json({ success: true, token: sign(safe), refresh_token: signRefresh(safe) });
    } catch {
        res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    res.json({ success: true });
});

// POST /api/auth/create-user  (first-time setup / admin only)
router.post('/create-user', async (req, res) => {
    const { email, password, name, role = 'staff', setup_key } = req.body;
    if (setup_key !== process.env.AMRD_JWT_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const hash = await bcrypt.hash(password, 12);
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_users').filter(u => u.email === email);
            if (existing.length) return res.status(409).json({ error: 'Email already exists' });
            const row = req.db.fileDb.create('amr_users', {
                email, name, role, password_hash: hash, is_active: true,
            });
            return res.status(201).json({ success: true, data: { id: row.id, email: row.email, name: row.name, role: row.role } });
        }
        const { rows } = await db.query(
            'INSERT INTO amr_users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
            [email, name, role, hash]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Google OAuth (PKCE) ──────────────────────────────────────────────────

// POST /api/auth/google/login — initiate PKCE flow
router.post('/google/login', (req, res) => {
    try {
        const auth                       = new GoogleOAuth();
        const { codeVerifier, codeChallenge } = auth.generatePKCE();
        const csrf      = auth.generateState();
        const sessionId = auth.generateSessionId();
        const state     = `${sessionId}:${csrf}`;

        auth.storePKCE(sessionId, { codeVerifier, state, redirectUri: auth.redirectUri });

        res.json({
            success: true,
            data: {
                sessionId,
                state,
                codeVerifier,
                authUrl: auth.createAuthUrl(state, codeChallenge),
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/auth/google/callback — Google redirects here, we relay to login
router.get('/google/callback', (req, res) => {
    const { code, state, error } = req.query;
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:9000').replace(/\/$/, '');

    if (error) return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(error)}`);
    if (!code || !state) return res.redirect(`${frontendUrl}/login?error=Missing+OAuth+parameters`);

    let sessionId;
    if (state.includes(':')) sessionId = state.split(':')[0];

    const dest = new URL(`${frontendUrl}/login`);
    dest.searchParams.set('code', code);
    dest.searchParams.set('state', state);
    if (sessionId) dest.searchParams.set('session_id', sessionId);
    res.redirect(dest.toString());
});

// POST /api/auth/google/exchange — exchange code for JWT
router.post('/google/exchange', async (req, res) => {
    const { code, state, session_id, code_verifier } = req.body;
    if (!code || !state) return res.status(400).json({ error: 'code and state required' });

    try {
        const auth      = new GoogleOAuth();
        let sessionId   = session_id;
        if (!sessionId && state.includes(':')) sessionId = state.split(':')[0];

        const pkceData     = auth.getPKCE(sessionId);
        const codeVerifier = pkceData?.codeVerifier || code_verifier;
        if (!codeVerifier) return res.status(400).json({ error: 'Session expired. Please sign in again.' });

        const tokens   = await auth.exchangeCode(code, codeVerifier);
        const userInfo = await auth.getUserInfo(tokens.access_token);

        let user;
        if (req.db.mode === 'nondb') {
            const existing = req.db.fileDb.find('amr_users').filter(u => u.email === userInfo.email);
            if (existing.length) {
                user = existing[0];
                req.db.fileDb.update('amr_users', user.id, {
                    last_login_at: new Date().toISOString(),
                    google_id:     userInfo.id,
                    picture:       userInfo.picture,
                });
            } else {
                user = req.db.fileDb.create('amr_users', {
                    email:     userInfo.email,
                    name:      userInfo.name,
                    role:      'staff',
                    google_id: userInfo.id,
                    picture:   userInfo.picture,
                    is_active: true,
                });
            }
        } else {
            const { rows } = await db.query(
                'SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [userInfo.email]
            );
            if (rows.length) {
                user = rows[0];
                await db.query(
                    'UPDATE amr_users SET last_login_at = NOW(), google_id = $2, picture = $3 WHERE id = $1',
                    [user.id, userInfo.id, userInfo.picture]
                );
            } else {
                const { rows: r } = await db.query(
                    `INSERT INTO amr_users (email, name, role, google_id, picture, is_active)
                     VALUES ($1,$2,'staff',$3,$4,true) RETURNING *`,
                    [userInfo.email, userInfo.name, userInfo.id, userInfo.picture]
                );
                user = r[0];
            }
        }

        const safe = {
            id:      user.id,
            email:   user.email,
            name:    user.name || userInfo.name,
            role:    user.role,
            picture: userInfo.picture,
        };
        res.json({
            success: true,
            data: {
                token:         sign(safe),
                refresh_token: signRefresh(safe),
                user:          safe,
            },
        });
    } catch (e) {
        console.error('Google exchange error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/sso/issue — issue a 60-second SSO token for tenant sites (requires auth)
router.post('/sso/issue', requireAuth, (req, res) => {
    const ssoSecret = process.env.SSO_SECRET;
    if (!ssoSecret) return res.status(503).json({ error: 'SSO not configured' });

    const { aud } = req.body;  // e.g. "rohas" — caller specifies target tenant
    if (!aud) return res.status(400).json({ error: 'aud (target tenant) is required' });

    const user     = req.staff;
    const now      = Math.floor(Date.now() / 1000);
    const payload  = { iss: 'amaradata', aud, sub: user.email, name: user.name, role: user.role, iat: now, exp: now + 60 };

    const header   = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body     = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig      = crypto.createHmac('sha256', ssoSecret).update(`${header}.${body}`).digest('base64url');
    const ssoToken = `${header}.${body}.${sig}`;

    const rohasUrl = process.env.ROHAS_URL || '';
    const loginUrl = rohasUrl ? `${rohasUrl}/auth/sso?sso_token=${ssoToken}` : null;

    res.json({ success: true, sso_token: ssoToken, login_url: loginUrl });
});

module.exports = router;
