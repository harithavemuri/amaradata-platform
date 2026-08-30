const secrets = require('./secrets');

// Calls a tenant site's /api/billing/* endpoints directly with its dedicated
// X-Amaradata-Api-Key (tenants.billing_api_key / _secret_arn) — NOT the SSO
// staff-impersonation flow tenant-sso-client.js uses for /api/admin/*, and
// NOT owner-portal-tenant-client.js's key (separate, dedicated credential
// per integration — least-privilege, so a leaked key can't reach the other
// integration). Replaces jobs/collect-metrics.js's old direct Postgres
// connection into the tenant's DB — see project-owner-portal.md's sibling
// memory on the billing-metrics fix (2026-08-30) for why that had to go:
// wrong database, wrong column names, and never had real credentials in
// production in the first place.

function unreachable(message, extra) {
    const err = new Error(message);
    err.tenantUnreachable = true;
    if (extra) Object.assign(err, extra);
    return err;
}

async function resolveApiKey(tenant) {
    try {
        return await secrets.getSecret(tenant.billing_api_key_secret_arn, { fallback: tenant.billing_api_key });
    } catch {
        return null;
    }
}

// Calls `path` on the tenant's own site. A 5xx or network failure is
// reported as `tenantUnreachable` (502 at the route/job layer); a 4xx from a
// reachable tenant (400 bad input) is a real, meaningful response and is
// thrown with `tenantStatus` set so the caller can pass the same status
// straight through instead of masking it as "unreachable".
async function callBillingApi(tenant, { method = 'GET', path } = {}) {
    if (!tenant.site_url) throw unreachable('Tenant has no site_url configured');

    const apiKey = await resolveApiKey(tenant);
    if (!apiKey) throw unreachable('Billing API key not configured for this tenant');

    const base = tenant.site_url.replace(/\/$/, '');
    let res;
    try {
        res = await fetch(`${base}${path}`, { method, headers: { 'X-Amaradata-Api-Key': apiKey } });
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

async function fetchMetrics(tenant, year, month) {
    const result = await callBillingApi(tenant, { method: 'GET', path: `/api/billing/metrics?year=${year}&month=${month}` });
    return result.data;
}

module.exports = { callBillingApi, fetchMetrics };
