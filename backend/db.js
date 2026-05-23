if (process.env.NONDB_MODE === 'true') {
    const noop = () => { throw new Error('DB unavailable in nondb mode'); };
    module.exports = { query: noop, writePool: null, readPool: null };
    return;
}

const { Pool } = require('pg');

const base = {
    host:              process.env.AMRD_DB_HOST || 'localhost',
    port:              parseInt(process.env.AMRD_DB_PORT || '5432'),
    database:          process.env.AMRD_DB_NAME || 'amaradata_platform',
    idleTimeoutMillis: 30000,
};

const writePool = new Pool({
    ...base,
    user:     process.env.AMRD_DB_WRITE_USER     || process.env.AMRD_DB_USER     || 'postgres',
    password: process.env.AMRD_DB_WRITE_PASSWORD || process.env.AMRD_DB_PASSWORD || '',
    max: 10,
});

const readPool = new Pool({
    ...base,
    user:     process.env.AMRD_DB_READ_USER     || process.env.AMRD_DB_USER     || 'postgres',
    password: process.env.AMRD_DB_READ_PASSWORD || process.env.AMRD_DB_PASSWORD || '',
    max: 10,
});

writePool.on('error', (err) => console.error('DB write-pool error', err));
readPool.on('error',  (err) => console.error('DB read-pool error',  err));

function query(sql, params) {
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)/i.test(sql);
    return (isWrite ? writePool : readPool).query(sql, params);
}

module.exports = { query, writePool, readPool };
