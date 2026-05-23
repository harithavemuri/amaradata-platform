const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');

exports.handler = async () => {
    const pool = new Pool({
        host:     process.env.AMRD_DB_HOST,
        port:     parseInt(process.env.AMRD_DB_PORT || '5432'),
        database: process.env.AMRD_DB_NAME,
        user:     process.env.AMRD_DB_WRITE_USER,
        password: process.env.AMRD_DB_WRITE_PASSWORD,
        max: 2,
        connectionTimeoutMillis: 10000,
    });

    try {
        const schema = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
        await pool.query(schema);
        console.log('Schema initialized successfully');
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (e) {
        console.error('Schema init failed:', e.message);
        return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    } finally {
        await pool.end();
    }
};
