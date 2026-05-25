const router                              = require('express').Router();
const bcrypt                              = require('bcryptjs');
const crypto                              = require('crypto');
const db                                  = require('../db');
const { sign, signRefresh, verifyRefresh, requireAuth } = require('../middleware/auth');
const GoogleOAuth                         = require('../auth/google-auth');
const { sendEmail }                       = require('../services/ses');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    try {
        let user;
        if (req.db.mode === 'nondb') {
            const users = req.db.fileDb.find('amr_users').filter(u => u.email === email && u.is_active);
            user = users[0];
        } else {
            const { rows } = await db.query(
                'SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [email]
            );
            user = rows[0];
        }

        if (!user || !(await bcrypt.compare(password, user.password_hash)))
            return res.status(401).json({ error: 'Invalid credentials' });

        if (req.db.mode === 'nondb') {
            req.db.fileDb.update('amr_users', user.id, { last_login_at: new Date().toISOString() });
        } else {
            await db.query('UPDATE amr_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        }

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

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    try {
        let user;
        if (req.db.mode === 'nondb') {
            user = req.db.fileDb.find('amr_users').find(u => u.email === email && u.is_active !== false);
        } else {
            const { rows } = await db.query('SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [email]);
            user = rows[0];
        }

        // Only send if the user has a password (not Google-only accounts)
        if (user && user.password_hash) {
            const token       = crypto.randomBytes(32).toString('hex');
            const expiresAt   = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:9000').replace(/\/$/, '');
            const resetLink   = `${frontendUrl}/reset-password?token=${token}`;
            const company     = process.env.COMPANY_NAME || 'AmaraData';

            if (req.db.mode === 'nondb') {
                req.db.fileDb.find('amr_password_reset_tokens')
                    .filter(t => t.user_id === user.id)
                    .forEach(t => req.db.fileDb.delete('amr_password_reset_tokens', t.id));
                req.db.fileDb.create('amr_password_reset_tokens', { user_id: user.id, token, expires_at: expiresAt });
                console.log(`[reset-link] ${resetLink}`);
            } else {
                await db.query('DELETE FROM amr_password_reset_tokens WHERE user_id = $1', [user.id]);
                await db.query(
                    'INSERT INTO amr_password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
                    [user.id, token, expiresAt]
                );
            }

            await sendEmail({
                to:      user.email,
                subject: `Reset your ${company} password`,
                html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
                    <div style="text-align:center;margin-bottom:24px">
                        <div style="display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,#1E3A5F,#0D9488)">
                            <svg viewBox="0 0 500 500" width="32" height="32"><path d="M250 50L50 400H150L180 340H320L350 400H450L250 50Z" fill="white"/><circle cx="215" cy="278" r="30" fill="rgba(14,165,233,0.8)"/><circle cx="285" cy="278" r="30" fill="rgba(14,165,233,0.8)"/></svg>
                        </div>
                        <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:12px">${company}</div>
                    </div>
                    <h2 style="color:#0f172a;margin:0 0 12px">Password Reset Request</h2>
                    <p style="color:#374151;margin:0 0 8px">Hi ${user.name || 'there'},</p>
                    <p style="color:#374151;margin:0 0 24px">We received a request to reset your <strong>${company}</strong> account password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
                    <div style="text-align:center;margin:28px 0">
                        <a href="${resetLink}" style="background:#0D9488;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Reset Password</a>
                    </div>
                    <p style="color:#64748b;font-size:12px;margin:0 0 6px">Or paste this link in your browser:</p>
                    <p style="color:#0D9488;font-size:12px;word-break:break-all;margin:0 0 24px">${resetLink}</p>
                    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
                    <p style="color:#94a3b8;font-size:11px;margin:0">If you didn't request a password reset, you can safely ignore this email. Your password won't change.</p>
                </div>`,
                text: `Reset your ${company} password\n\nHi ${user.name || 'there'},\n\nClick the link below to reset your password (expires in 1 hour):\n${resetLink}\n\nIf you didn't request this, ignore this email.`,
            });
        }

        // Always return 200 — don't reveal whether the email is registered
        res.json({ success: true, message: "If that email is registered, you'll receive a reset link shortly." });
    } catch (e) {
        console.error('forgot-password error:', e.message);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        if (req.db.mode === 'nondb') {
            const tokenRow = req.db.fileDb.find('amr_password_reset_tokens')
                .find(t => t.token === token && new Date(t.expires_at) > new Date());
            if (!tokenRow) return res.status(400).json({ error: 'Invalid or expired reset link' });
            const user = req.db.fileDb.getById('amr_users', tokenRow.user_id);
            if (!user || user.is_active === false) return res.status(400).json({ error: 'User not found' });
            const hash = await bcrypt.hash(password, 12);
            req.db.fileDb.update('amr_users', user.id, { password_hash: hash });
            req.db.fileDb.delete('amr_password_reset_tokens', tokenRow.id);
        } else {
            const { rows } = await db.query(
                `SELECT t.id, t.user_id, u.is_active
                 FROM amr_password_reset_tokens t
                 JOIN amr_users u ON u.id = t.user_id
                 WHERE t.token = $1 AND t.expires_at > NOW()`,
                [token]
            );
            const tokenRow = rows[0];
            if (!tokenRow || !tokenRow.is_active) return res.status(400).json({ error: 'Invalid or expired reset link' });
            const hash = await bcrypt.hash(password, 12);
            await db.query('UPDATE amr_users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [tokenRow.user_id, hash]);
            await db.query('DELETE FROM amr_password_reset_tokens WHERE token = $1', [token]);
        }

        res.json({ success: true, message: 'Password updated. You can now sign in.' });
    } catch (e) {
        console.error('reset-password error:', e.message);
        res.status(500).json({ error: 'Failed to reset password' });
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
