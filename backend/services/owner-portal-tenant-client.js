const secrets = require('./secrets');

// Calls a tenant site's /api/owner-portal/* endpoints directly with its
// dedicated X-Amaradata-Api-Key (tenants.owner_portal_api_key /
// _secret_arn) — NOT the SSO staff-impersonation flow tenant-sso-client.js
// uses for /api/admin/*. This is the same service-to-service credential
// convention rohas-group's backend/middleware/service-auth.js expects (see
// project-owner-portal.md): a dedicated key per integration, never the
// billing key, never a staff session.

function unreachable(message, extra) {
    const err = new Error(message);
    err.tenantUnreachable = true;
    if (extra) Object.assign(err, extra);
    return err;
}

async function resolveApiKey(tenant) {
    try {
        return await secrets.getSecret(tenant.owner_portal_api_key_secret_arn, { fallback: tenant.owner_portal_api_key });
    } catch {
        return null;
    }
}

// Calls `path` on the tenant's own site. A 5xx or network failure is
// reported as `tenantUnreachable` (502 at the route layer); a 4xx from a
// reachable tenant (400/404/409 — bad input, no such owner, duplicate
// identifier) is a real, meaningful response and is thrown with
// `tenantStatus` set so the caller can pass the same status straight
// through instead of masking it as "unreachable".
async function callOwnerPortalApi(tenant, { method = 'GET', path, body } = {}) {
    if (!tenant.site_url) throw unreachable('Tenant has no site_url configured');

    const apiKey = await resolveApiKey(tenant);
    if (!apiKey) throw unreachable('Owner portal API key not configured for this tenant');

    const base = tenant.site_url.replace(/\/$/, '');
    let res;
    try {
        res = await fetch(`${base}${path}`, {
            method,
            headers: {
                'X-Amaradata-Api-Key': apiKey,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw unreachable(`Tenant API call failed: ${e.message}`);
    }

    const data = await res.json().catch(() => null);

    if (res.status >= 500) {
        throw unreachable(data?.message || data?.error || `Tenant API returned ${res.status}`, { status: res.status });
    }
    if (!res.ok) {
        const err = new Error(data?.message || data?.error || `Tenant API returned ${res.status}`);
        err.tenantStatus = res.status;
        throw err;
    }
    return data;
}

async function searchOwners(tenant, query) {
    const qs = new URLSearchParams({ q: query }).toString();
    const result = await callOwnerPortalApi(tenant, { method: 'GET', path: `/api/owner-portal/search-owners?${qs}` });
    return result.data || [];
}

async function linkOwner(tenant, { project_id, owner_id, identifier }) {
    const result = await callOwnerPortalApi(tenant, {
        method: 'PUT', path: '/api/owner-portal/link', body: { project_id, owner_id, identifier },
    });
    return result.data;
}

module.exports = { callOwnerPortalApi, searchOwners, linkOwner };
