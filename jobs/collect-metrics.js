/**
 * Billing metrics collector.
 * Calls each tenant's own GET /api/billing/metrics (service-to-service,
 * tenants.billing_api_key) and writes the returned monthly snapshot to the
 * AmaraData platform DB.
 *
 * Run manually:   node jobs/collect-metrics.js [--year=2026] [--month=4]
 * Or schedule via cron on the 1st of each month.
 *
 * Rewritten 2026-08-30 — the previous version opened a direct Postgres
 * connection into the tenant's own database (see
 * [[feedback_no_direct_cross_db_reads]]) and, on inspection, was broken
 * three separate ways: it connected to the tenant's main/shared DB instead
 * of looping the per-project DBs where properties/rent_payments actually
 * live, it queried a rent_payments.payment_date column that doesn't exist
 * (the real column is paid_date), and it summed a properties.sale_price
 * column that doesn't exist at all. It also never had real credentials
 * (tenant_db_user/tenant_db_secret_arn) populated for the real rohas tenant
 * row in production — every billing_metrics row and invoice seen in
 * production before this fix was hand-written seed data
 * (database/seed_rohas.sql), never a real collected number. See
 * project-owner-portal.md's sibling memory for the full investigation.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const platformDb = require('../backend/db');
const { fetchMetrics } = require('../backend/services/billing-tenant-client');

async function collectForTenant(tenant, year, month) {
    const metrics = await fetchMetrics(tenant, year, month);

    await platformDb.query(
        `INSERT INTO billing_metrics
         (tenant_id,period_year,period_month,sales_count,sales_value,rental_units,rental_income,active_properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, period_year, period_month)
         DO UPDATE SET sales_count=$4, sales_value=$5, rental_units=$6,
                       rental_income=$7, active_properties=$8, collected_at=NOW()`,
        [tenant.id, year, month,
         metrics.sales_count, metrics.sales_value, metrics.rental_units,
         metrics.rental_income, metrics.active_properties],
    );

    console.log(`  ✓ ${tenant.name}: ${metrics.sales_count} sales (₹${metrics.sales_value}), ` +
                `${metrics.rental_units} rental units (₹${metrics.rental_income})`);
    return metrics;
}

async function run() {
    if (process.env.NONDB_MODE === 'true') {
        console.log('[NonDB mode] Metrics collection requires a live tenant DB. Skipping.');
        process.exit(0);
    }

    const args  = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
    const now   = new Date();
    const year  = parseInt(args.year  || (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()));
    const month = parseInt(args.month || (now.getMonth() === 0 ? 12 : now.getMonth()));

    console.log(`\nCollecting billing metrics for ${year}-${String(month).padStart(2,'0')}...\n`);

    const { rows: tenants } = await platformDb.query(
        `SELECT * FROM tenants WHERE status='active' AND site_url IS NOT NULL`
    );

    if (!tenants.length) { console.log('No active tenants with a site_url configured.'); process.exit(0); }

    for (const tenant of tenants) {
        process.stdout.write(`  ${tenant.name} (${tenant.slug})... `);
        try {
            await collectForTenant(tenant, year, month);
        } catch (e) {
            console.error(`FAILED: ${e.message}`);
        }
    }

    console.log('\nDone.\n');
    process.exit(0);
}

if (require.main === module) {
    run().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { collectForTenant, run };
