// Checks a tenant site's own public GET /health — no API key needed, same
// public/no-auth exemption AmaraData's own GET /health has (server.js) — so
// unlike billing-tenant-client.js / owner-portal-tenant-client.js this needs
// no secret lookup at all. Every result is normalized and this never throws
// for an individual tenant's failure (same per-tenant try/catch contract as
// jobs/collect-metrics.js's collectAllTenants), since a health panel needs
// to *display* every tenant's status, not abort on the first down one.

const DEFAULT_TIMEOUT_MS = 5000;

function baseResult(tenant) {
    return { tenant_id: tenant.id, tenant_name: tenant.name, slug: tenant.slug, site_url: tenant.site_url || null };
}

async function checkTenantHealth(tenant, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    const base = baseResult(tenant);

    if (!tenant.site_url) {
        return { ...base, reachable: false, status_code: null, latency_ms: null, remote: null, error: 'No site_url configured' };
    }

    const url = `${tenant.site_url.replace(/\/$/, '')}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let res;
    try {
        res = await fetchImpl(url, { signal: controller.signal });
    } catch (e) {
        return {
            ...base, reachable: false, status_code: null, latency_ms: Date.now() - startedAt, remote: null,
            error: e.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : `Request failed: ${e.message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const latency_ms = Date.now() - startedAt;
    const remote = await res.json().catch(() => null);

    if (!res.ok) {
        return { ...base, reachable: false, status_code: res.status, latency_ms, remote, error: `Tenant returned ${res.status}` };
    }
    return { ...base, reachable: true, status_code: res.status, latency_ms, remote, error: null };
}

async function checkAllTenantsHealth(tenants, opts) {
    return Promise.all(tenants.map(t => checkTenantHealth(t, opts)));
}

module.exports = { checkTenantHealth, checkAllTenantsHealth, DEFAULT_TIMEOUT_MS };
