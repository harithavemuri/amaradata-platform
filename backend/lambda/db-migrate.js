const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-south-1' });

exports.handler = async () => {
    const secretRes = await sm.send(new GetSecretValueCommand({
        SecretId: process.env.DB_MASTER_SECRET_NAME || '/amaradata/aurora/master-password',
    }));

    // The secret is a raw password string; the username comes from an env var.
    // Default to 'postgres' — the RDS hidden superuser that bypasses schema ACLs.
    const password = secretRes.SecretString.trim();
    const user     = process.env.DB_MASTER_USER || 'postgres';

    const pool = new Pool({
        host:                   process.env.AMRD_DB_HOST,
        port:                   5432,
        database:               process.env.AMRD_DB_NAME,
        user,
        password,
        max:                    2,
        connectionTimeoutMillis: 60000,
    });

    const schema = fs.readFileSync(
        path.join(__dirname, '../../database/schema.sql'), 'utf8'
    );

    // Split on semicolons and run each statement individually so one failure
    // (e.g. duplicate seed row) does not abort the rest.
    const statements = schema
        .split(/;\s*(\n|$)/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

    let ran = 0, errs = [];
    const client = await pool.connect();
    try {
        for (const stmt of statements) {
            try {
                await client.query(stmt);
                ran++;
            } catch (e) {
                errs.push({ sql: stmt.slice(0, 120), error: e.message });
                console.error('[db-migrate] stmt error:', e.message, '|', stmt.slice(0, 80));
            }
        }
    } finally {
        client.release();
        await pool.end();
    }

    const criticalErrors = errs.filter(
        e => !e.error.includes('already exists') && !e.error.includes('duplicate key')
    );

    if (criticalErrors.length) {
        console.error('[db-migrate] critical errors:', JSON.stringify(criticalErrors));
        return { success: false, error: criticalErrors[0].error, details: criticalErrors };
    }

    console.log(`[db-migrate] done: ${ran} statements run, ${errs.length} non-critical skipped`);
    return { success: true, message: `${ran} statements applied, ${errs.length} skipped (already exist)` };
};
