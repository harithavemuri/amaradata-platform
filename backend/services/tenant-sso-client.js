const secrets           = require('./secrets');
const { signSsoToken }  = require('./sso-token');

// Resolved at runtime through services/secrets.js's cache, same convention as
// every other secret lookup in this codebase (see
// project-realtime-secret-fetch-standard.md) — no AMRD_JWT_SECRET_ID-style
// baked-in env var.
const SSO_SECRET_ID = process.env.SSO_SECRET_ID;

function unreachable(message, extra) {
    const err = new Error(message);
    err.tenantUnreachable = true;
    if (extra) Object.assign(err, extra);
    return err;
}

// Redeems a freshly-minted SSO token against a tenant site's existing SSO
// redeemer (rohas-group's GET /auth/sso — unmodified, human-browser-shaped:
// it 302s with the tenant's own session JWT as an sso_jwt query param on the
// Location header). `redirect: 'manual'` stops fetch from following it so
// the JWT can be read out instead of being sent off to whatever page it
// redirects to.
async function redeemSsoToken(siteUrl, ssoToken) {
    const base = siteUrl.replace(/\/$/, '');
    const res  = await fetch(`${base}/auth/sso?sso_token=${encodeURIComponent(ssoToken)}`, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) throw unreachable('SSO redemption did not return a redirect');
    const redirectUrl = new URL(location, base);
    const sessionJwt   = redirectUrl.searchParams.get('sso_jwt');
    if (!sessionJwt) throw unreachable('SSO redemption redirect was missing sso_jwt');
    return sessionJwt;
}

// Mints a 60s SSO token for `staff` (the real AmaraData caller — their role
// passes straight through, see the super_admin rename that made this
// possible without a hardcoded role translation), redeems it against
// `tenant.site_url`, then calls `path` on that tenant's own admin API using
// the redeemed session JWT as Bearer auth.
async function callTenantApi(tenant, staff, { method = 'GET', path, body } = {}) {
    if (!tenant.site_url) throw unreachable('Tenant has no site_url configured');

    // getSecret() throws when neither SSO_SECRET_ID nor the SSO_SECRET fallback
    // is set at all (same "not configured" case POST /api/auth/sso/issue
    // already handles this way) — caught here so a missing SSO config reads as
    // a normal tenantUnreachable 502, not an uncaught 500.
    let ssoSecret;
    try {
        ssoSecret = await secrets.getSecret(SSO_SECRET_ID, { fallback: process.env.SSO_SECRET });
    } catch {
        throw unreachable('SSO not configured');
    }
    if (!ssoSecret) throw unreachable('SSO not configured');

    const ssoToken = signSsoToken(ssoSecret, { aud: tenant.slug, sub: staff.email, name: staff.name, role: staff.role });

    let sessionJwt;
    try {
        sessionJwt = await redeemSsoToken(tenant.site_url, ssoToken);
    } catch (e) {
        if (e.tenantUnreachable) throw e;
        throw unreachable(`SSO redemption failed: ${e.message}`);
    }

    const base = tenant.site_url.replace(/\/$/, '');
    let res;
    try {
        res = await fetch(`${base}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${sessionJwt}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw unreachable(`Tenant API call failed: ${e.message}`);
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) throw unreachable(data?.error || `Tenant API returned ${res.status}`, { status: res.status });
    return data;
}

module.exports = { callTenantApi, redeemSsoToken };
