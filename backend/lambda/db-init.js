const { Pool }             = require('pg');
const fs                   = require('fs');
const path                 = require('path');
const { withConnectRetry } = require('../services/db-retry');

exports.handler = async () => {
    // Per-attempt timeout is short on purpose: DBInitFn has a 120s Lambda timeout
    // (template.yaml), and a cold Aurora Serverless v2 resume can take up to ~30s,
    // so a handful of shorter attempts recover faster than one long one and still
    // fit inside the budget (3 attempts x 15s connect + backoff <= well under 120s).
    const pool = new Pool({
        host:     process.env.AMRD_DB_HOST,
        port:     parseInt(process.env.AMRD_DB_PORT || '5432'),
        database: process.env.AMRD_DB_NAME,
        user:     process.env.AMRD_DB_WRITE_USER,
        password: process.env.AMRD_DB_WRITE_PASSWORD,
        max: 2,
        connectionTimeoutMillis: 15000,
    });

    try {
        const schema = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
        await withConnectRetry(
            () => pool.query(schema),
            { retries: 3, delayMs: 5000, onRetry: (err, attempt) =>
                console.warn(`[db-init] connectivity error on attempt ${attempt}, retrying: ${err.message}`) },
        );
        console.log('Schema initialized successfully');
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (e) {
        console.error('Schema init failed:', e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    } finally {
        await pool.end();
    }
};
