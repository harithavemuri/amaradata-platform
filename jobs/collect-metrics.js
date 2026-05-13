/**
 * Billing metrics collector.
 * Reads each tenant's operational DB (read-only) and writes monthly
 * snapshots to the AmaraData platform DB.
 *
 * Run manually:   node jobs/collect-metrics.js [--year=2026] [--month=4]
 * Or schedule via cron on the 1st of each month.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool }   = require('pg');
const platformDb = require('../backend/db');

async function collectForTenant(tenant, year, month) {
    const tenantPool = new Pool({
        host:     tenant.tenant_db_host,
        port:     tenant.tenant_db_port || 5432,
        database: tenant.tenant_db_name,
        user:     tenant.tenant_db_user,
        password: tenant.tenant_db_password,
        connectionTimeoutMillis: 5000,
    });

    try {
        const start = `${year}-${String(month).padStart(2,'0')}-01`;
        const end   = new Date(year, month, 1).toISOString().slice(0, 10); // first day of next month

        // Properties sold this month
        const salesRes = await tenantPool.query(
            `SELECT COUNT(*) AS sales_count, COALESCE(SUM(sale_price),0) AS sales_value
             FROM properties WHERE status='sold' AND updated_at >= $1 AND updated_at < $2`,
            [start, end]
        );

        // Rent payments collected this month
        const rentalRes = await tenantPool.query(
            `SELECT COUNT(DISTINCT rental_property_id) AS rental_units,
                    COALESCE(SUM(amount),0) AS rental_income
             FROM rent_payments WHERE payment_date >= $1 AND payment_date < $2 AND status='paid'`,
            [start, end]
        );

        // Total active properties
        const propRes = await tenantPool.query(
            `SELECT COUNT(*) AS active_properties FROM properties WHERE status != 'sold'`
        );

        const metrics = {
            tenant_id:          tenant.id,
            period_year:        year,
            period_month:       month,
            sales_count:        parseInt(salesRes.rows[0].sales_count),
            sales_value:        parseFloat(salesRes.rows[0].sales_value),
            rental_units:       parseInt(rentalRes.rows[0].rental_units),
            rental_income:      parseFloat(rentalRes.rows[0].rental_income),
            active_properties:  parseInt(propRes.rows[0].active_properties),
        };

        await platformDb.query(
            `INSERT INTO billing_metrics
             (tenant_id,period_year,period_month,sales_count,sales_value,rental_units,rental_income,active_properties)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, period_year, period_month)
             DO UPDATE SET sales_count=$4, sales_value=$5, rental_units=$6,
                           rental_income=$7, active_properties=$8, collected_at=NOW()`,
            [metrics.tenant_id, metrics.period_year, metrics.period_month,
             metrics.sales_count, metrics.sales_value, metrics.rental_units,
             metrics.rental_income, metrics.active_properties]
        );

        console.log(`  ✓ ${tenant.name}: ${metrics.sales_count} sales (₹${metrics.sales_value}), ` +
                    `${metrics.rental_units} rental units (₹${metrics.rental_income})`);
        return metrics;
    } finally {
        await tenantPool.end();
    }
}

async function run() {
    const args  = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
    const now   = new Date();
    // Default to previous month
    const year  = parseInt(args.year  || (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()));
    const month = parseInt(args.month || (now.getMonth() === 0 ? 12 : now.getMonth()));

    console.log(`\nCollecting billing metrics for ${year}-${String(month).padStart(2,'0')}...\n`);

    const { rows: tenants } = await platformDb.query(
        `SELECT * FROM tenants WHERE status='active' AND tenant_db_host IS NOT NULL`
    );

    if (!tenants.length) { console.log('No active tenants with DB connection configured.'); process.exit(0); }

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

run().catch(e => { console.error(e); process.exit(1); });
