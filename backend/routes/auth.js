const router                              = require('express').Router();
const bcrypt                              = require('bcryptjs');
const crypto                              = require('crypto');
const db                                  = require('../db');
const { sign, signRefresh, verifyRefresh, requireAuth, getJwtSecret } = require('../middleware/auth');
const GoogleOAuth                         = require('../auth/google-auth');
const { sendEmail }                       = require('../services/ses');
const secrets                             = require('../services/secrets');
const { sendError }                       = require('../services/http-errors');
const { blockNonDbWrite }                 = require('../middleware/block-nondb-write');
const { signSsoToken }                    = require('../services/sso-token');

// Resolved at runtime through services/secrets.js, not baked into the Lambda
// env at deploy time (see project-realtime-secret-fetch-standard.md).
const SSO_SECRET_ID = process.env.SSO_SECRET_ID;

// Role priority — lower number = higher privilege
const ROLE_PRIORITY = { super_admin: 1, admin: 2, sales_manager: 3, billing: 4, staff: 5 };

function effectiveRole(directRole, groupRoleNames) {
    const all = [directRole, ...groupRoleNames].filter(Boolean);
    if (!all.length) return 'staff';
    return all.sort((a, b) => (ROLE_PRIORITY[a] || 99) - (ROLE_PRIORITY[b] || 99))[0];
}

async function resolveEffectiveRole(user, dbMode, fileDb) {
    if (dbMode === 'nondb') {
        const memberships  = fileDb.find('amr_group_members').filter(m => m.user_id == user.id);
        const groups       = fileDb.find('amr_groups');
        const groupTenants = fileDb.find('group_tenant');
        const roles        = fileDb.find('amr_roles');
        const groupIds     = new Set(
            memberships
                .filter(m => groups.find(g => g.id == m.group_id && g.is_active !== false))
                .map(m => m.group_id)
        );
        const groupRoles = groupTenants
            .filter(gt => groupIds.has(gt.group_id))
            .map(gt => roles.find(r => r.id == gt.role_id)?.name)
            .filter(Boolean);
        return effectiveRole(user.role, groupRoles);
    }
    const { rows } = await db.query(`
        SELECT DISTINCT r.name FROM amr_group_members m
        JOIN amr_groups g    ON g.id = m.group_id AND g.is_active = true
        JOIN group_tenant gt ON gt.group_id = g.id
        JOIN amr_roles r     ON r.id = gt.role_id
        WHERE m.user_id = $1
    `, [user.id]).catch(() => ({ rows: [] }));
    return effectiveRole(user.role, rows.map(r => r.name));
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
        let user;
        if (req.db.mode === 'nondb') {
            const uLower = username.toLowerCase();
            const users = req.db.fileDb.find('amr_users').filter(u => u.username?.toLowerCase() === uLower && u.is_active);
            user = users[0];
        } else {
            const { rows } = await db.query(
                'SELECT * FROM amr_users WHERE lower(username) = lower($1) AND is_active = true', [username]
            );
            user = rows[0];
        }

        if (!user || !(await bcrypt.compare(password, user.password_hash)))
            return res.status(401).json({ error: 'Invalid credentials' });

        // property_owner accounts (portal.amaradata.com) are the same
        // amr_users table/password hash as staff, isolated by role rather
        // than a separate table — but must never be able to log into this
        // staff app. See [[project_owner_portal]] in rohas-group's memory.
        if (user.role === 'property_owner')
            return res.status(403).json({ error: 'Property owner accounts cannot access this app. Use portal.amaradata.com instead.' });

        // Login audit — bookkeeping side effect of a successful login, not a
        // "data write" this app otherwise blocks in NonDB mode (see
        // backend/middleware/block-nondb-write.js's doc comment).
        if (req.db.mode === 'nondb') {
            req.db.fileDb.update('amr_users', user.id, { last_login_at: new Date().toISOString() });
            req.db.fileDb.create('login_audit', {
                user_id: user.id, method: 'password', ip_address: req.ip, logged_in_at: new Date().toISOString(),
            });
        } else {
            await db.query('UPDATE amr_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
            await db.query(
                'INSERT INTO login_audit (user_id, method, ip_address) VALUES ($1, $2, $3)',
                [user.id, 'password', req.ip]
            );
        }

        const role = await resolveEffectiveRole(user, req.db.mode, req.db.fileDb);
        const safe = { id: user.id, username: user.username, email: user.email, name: user.name, role };
        res.json({ success: true, token: await sign(safe), refresh_token: await signRefresh(safe), user: safe });
    } catch (e) {
        sendError(res, e, '[auth]');
    }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
    try {
        const payload = await verifyRefresh(refresh_token);
        const safe    = { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
        res.json({ success: true, token: await sign(safe), refresh_token: await signRefresh(safe) });
    } catch {
        res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    res.json({ success: true });
});

// POST /api/auth/create-user  (first-time setup / admin only)
router.post('/create-user', blockNonDbWrite, async (req, res) => {
    const { email, password, name, role = 'staff', setup_key } = req.body;
    const username = req.body.username || email;  // default username to email for backward compat
    try {
        if (setup_key !== await getJwtSecret()) return res.status(403).json({ error: 'Forbidden' });
    } catch {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const hash = await bcrypt.hash(password, 12);
        const { rows } = await db.query(
            'INSERT INTO amr_users (username, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,email,name,role',
            [username, email, name, role, hash]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
        sendError(res, e, '[auth]');
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
        console.error('[auth]', e.message);
        res.status(500).json({ error: 'Internal server error' });
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
            // Updating an existing user's last_login_at/google_id/logo_url on
            // re-login is the same kind of bookkeeping side effect plain
            // /login's last_login_at update is (see block-nondb-write.js) —
            // allowed even though NonDB mode is otherwise read-only. Creating
            // a brand-new account (first-time Google sign-in) is a real write
            // and is blocked below.
            const emailLower = userInfo.email.toLowerCase();
            const existing = req.db.fileDb.find('amr_users').filter(u => u.email?.toLowerCase() === emailLower);
            if (!existing.length) {
                return res.status(403).json({ error: 'NonDB mode is read-only — writes are not supported.' });
            }
            user = existing[0];
            req.db.fileDb.update('amr_users', user.id, {
                last_login_at: new Date().toISOString(),
                google_id:     userInfo.id,
                logo_url:      userInfo.picture,
            });
            req.db.fileDb.create('login_audit', {
                user_id: user.id, method: 'google', ip_address: req.ip, logged_in_at: new Date().toISOString(),
            });
        } else {
            const { rows } = await db.query(
                'SELECT * FROM amr_users WHERE lower(email) = lower($1) AND is_active = true', [userInfo.email]
            );
            if (rows.length) {
                user = rows[0];
                await db.query(
                    'UPDATE amr_users SET last_login_at = NOW(), google_id = $2, logo_url = $3 WHERE id = $1',
                    [user.id, userInfo.id, userInfo.picture]
                );
            } else {
                const { rows: r } = await db.query(
                    `INSERT INTO amr_users (username, email, name, role, google_id, logo_url, is_active)
                     VALUES ($1,$2,$3,'staff',$4,$5,true) RETURNING *`,
                    [userInfo.email, userInfo.email, userInfo.name, userInfo.id, userInfo.picture]
                );
                user = r[0];
            }
            await db.query(
                'INSERT INTO login_audit (user_id, method, ip_address) VALUES ($1, $2, $3)',
                [user.id, 'google', req.ip]
            );
        }

        // Same isolation as plain /login — see the comment there.
        if (user.role === 'property_owner')
            return res.status(403).json({ error: 'Property owner accounts cannot access this app. Use portal.amaradata.com instead.' });

        const role = await resolveEffectiveRole(user, req.db.mode, req.db.fileDb);
        const safe = {
            id:        user.id,
            username:  user.username,
            email:     user.email,
            name:      user.name || userInfo.name,
            role,
            logo_url:  userInfo.picture,
        };
        res.json({
            success: true,
            data: {
                token:         await sign(safe),
                refresh_token: await signRefresh(safe),
                user:          safe,
            },
        });
    } catch (e) {
        sendError(res, e, '[auth] google/exchange:');
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', blockNonDbWrite, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    try {
        const { rows } = await db.query('SELECT * FROM amr_users WHERE lower(email) = lower($1) AND is_active = true', [email]);
        const user = rows[0];

        // Only send if the user has a password (not Google-only accounts)
        if (user && user.password_hash) {
            const token       = crypto.randomBytes(32).toString('hex');
            const expiresAt   = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:9000').replace(/\/$/, '');
            const resetLink   = `${frontendUrl}/reset-password?token=${token}`;
            const company     = process.env.COMPANY_NAME || 'AmaraData';

            await db.query('DELETE FROM amr_password_reset_tokens WHERE user_id = $1', [user.id]);
            await db.query(
                'INSERT INTO amr_password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
                [user.id, token, expiresAt]
            );

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
        sendError(res, e, 'forgot-password error:', 'Failed to process request');
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', blockNonDbWrite, async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
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

        res.json({ success: true, message: 'Password updated. You can now sign in.' });
    } catch (e) {
        sendError(res, e, 'reset-password error:', 'Failed to reset password');
    }
});

// POST /api/auth/sso/issue — issue a 60-second SSO token for tenant sites (requires auth)
router.post('/sso/issue', requireAuth, async (req, res) => {
    // getSecret() throws when neither SSO_SECRET_ID nor the SSO_SECRET fallback is
    // set at all — that's the same "not configured" case this route has always
    // reported as a clean 503, not a 500, so it's caught rather than left to bubble.
    let ssoSecret;
    try {
        ssoSecret = await secrets.getSecret(SSO_SECRET_ID, { fallback: process.env.SSO_SECRET });
    } catch {
        return res.status(503).json({ error: 'SSO not configured' });
    }
    if (!ssoSecret) return res.status(503).json({ error: 'SSO not configured' });

    const { aud } = req.body;  // e.g. "rohas" — caller specifies target tenant
    if (!aud) return res.status(400).json({ error: 'aud (target tenant) is required' });

    const user     = req.staff;
    const ssoToken = signSsoToken(ssoSecret, { aud, sub: user.email, name: user.name, role: user.role });

    const rohasUrl = process.env.ROHAS_URL || '';
    const loginUrl = rohasUrl ? `${rohasUrl}/auth/sso?sso_token=${ssoToken}` : null;

    res.json({ success: true, sso_token: ssoToken, login_url: loginUrl });
});

module.exports = router;
