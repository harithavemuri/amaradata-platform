const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.AMRD_DB_HOST     || 'localhost',
    port:     parseInt(process.env.AMRD_DB_PORT || '5432'),
    database: process.env.AMRD_DB_NAME     || 'amaradata_platform',
    user:     process.env.AMRD_DB_USER     || 'postgres',
    password: process.env.AMRD_DB_PASSWORD || '',
    max: 10,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    console.error('Unexpected DB client error', err);
});

module.exports = { query: (...args) => pool.query(...args), pool };
