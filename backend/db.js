if (process.env.NONDB_MODE === 'true') {
    const noop = () => { throw new Error('DB unavailable in nondb mode'); };
    module.exports = { query: noop, writePool: null, readPool: null };
    return;
}

const { Pool, types } = require('pg');

// Return NUMERIC/DECIMAL (OID 1700) and FLOAT4/FLOAT8 (OID 700/701) as JS numbers, not strings.
// pg returns numeric columns as strings by default to avoid float precision loss,
// but our routes store fixed-precision values (2 dp) that tests compare as numbers.
const parseFloat_ = v => v === null ? null : parseFloat(v);
types.setTypeParser(1700, parseFloat_); // NUMERIC / DECIMAL
types.setTypeParser(700,  parseFloat_); // FLOAT4
types.setTypeParser(701,  parseFloat_); // FLOAT8
// Return DATE as "YYYY-MM-DD" string instead of a Date object so GraphQL
// String fields don't fall back to String(dateObj) (locale-dependent garbage).
types.setTypeParser(1082, v => v);      // DATE

const { getSecret, invalidate } = require('./services/secrets');
const { withAuthRetry }         = require('./services/db-retry');

const WRITE_PASSWORD_SECRET_ID = process.env.AMRD_DB_WRITE_PASSWORD_SECRET_ID;
const READ_PASSWORD_SECRET_ID  = process.env.AMRD_DB_READ_PASSWORD_SECRET_ID;

const base = {
    host:              process.env.AMRD_DB_HOST || 'localhost',
    port:              parseInt(process.env.AMRD_DB_PORT || '5432'),
    database:          process.env.AMRD_DB_NAME || 'amaradata_platform',
    idleTimeoutMillis: 30000,
};

// Passwords are supplied as a function, not a string: pg calls it per new
// connection, so a rotated secret is picked up automatically once the cache TTL
// in services/secrets.js lapses — no redeploy needed. Previously these were
// static env vars baked in by CloudFormation at deploy time, which meant
// rotating a secret broke every running instance until the next deploy.
//
// Backward compatible: with no *_SECRET_ID set, getSecret() short-circuits to
// the same env var used before and never calls AWS (local dev, tests, and any
// environment not yet migrated to runtime resolution).
const writePool = new Pool({
    ...base,
    user:     process.env.AMRD_DB_WRITE_USER || process.env.AMRD_DB_USER || 'postgres',
    password: () => getSecret(WRITE_PASSWORD_SECRET_ID, {
        fallback: process.env.AMRD_DB_WRITE_PASSWORD || process.env.AMRD_DB_PASSWORD || '',
    }),
    max: 10,
});

const readPool = new Pool({
    ...base,
    user:     process.env.AMRD_DB_READ_USER || process.env.AMRD_DB_USER || 'postgres',
    password: () => getSecret(READ_PASSWORD_SECRET_ID, {
        fallback: process.env.AMRD_DB_READ_PASSWORD || process.env.AMRD_DB_PASSWORD || '',
    }),
    max: 10,
});

writePool.on('error', (err) => console.error('DB write-pool error', err));
readPool.on('error',  (err) => console.error('DB read-pool error',  err));

function query(sql, params) {
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)/i.test(sql);
    const pool     = isWrite ? writePool : readPool;
    const secretId = isWrite ? WRITE_PASSWORD_SECRET_ID : READ_PASSWORD_SECRET_ID;

    // A rotated password only breaks *new* pool connections (existing sessions
    // survive ALTER ROLE), so an auth failure here means the cached value is
    // stale — drop it and retry once with a freshly fetched password.
    return withAuthRetry(
        () => pool.query(sql, params),
        () => invalidate(secretId),
    );
}

module.exports = { query, writePool, readPool };
