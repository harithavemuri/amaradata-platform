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
// enhancements.issue_id is BIGINT (OID 20) — pg returns it as a string for the
// same precision-safety reason as NUMERIC above, but every caller in this repo
// (routes, jobs/sync-tenant-fixes.js, tests) treats it as a plain JS number and
// compares it with ===, so a string here silently breaks those comparisons.
// Values are timestamp-derived issue ids, always well within safe-integer range.
types.setTypeParser(20, v => v === null ? null : parseInt(v, 10)); // BIGINT / INT8

const fs   = require('fs');
const path = require('path');

const { getSecret, invalidate } = require('./services/secrets');
const { withAuthRetry, withConnectRetry, isConnectivityError } = require('./services/db-retry');

const WRITE_PASSWORD_SECRET_ID = process.env.AMRD_DB_WRITE_PASSWORD_SECRET_ID;
const READ_PASSWORD_SECRET_ID  = process.env.AMRD_DB_READ_PASSWORD_SECRET_ID;

// Every successful write mirrors its table's current state to
// transactiondata/<table>.json, same target directory jobs/export-db-to-files.js
// and NonDB mode's FileDbService use (see project-db-write-file-mirror.md).
const MANIFEST           = require('../metadata/manifest.json');
const MIRRORED_TABLES    = new Set(MANIFEST.tables);
const TRANSACTIONDATA_DIR = process.env.TRANSACTIONDATA_DIR
    ? path.resolve(process.env.TRANSACTIONDATA_DIR)
    : path.join(__dirname, '../transactiondata');

// Lambda's deployment package (/var/task, where TRANSACTIONDATA_DIR resolves
// by default) is read-only outside /tmp — fs.writeFileSync there throws EROFS.
// When deployed, template.yaml sets this to a dedicated S3 bucket instead
// (ApiFn only — see template.yaml's comment on why not Globals); local dev and
// tests never set it, so they keep writing straight to disk, unchanged. See
// project-nondb-read-only.md.
const TRANSACTIONDATA_S3_BUCKET = process.env.TRANSACTIONDATA_S3_BUCKET;
let _s3Client;
function _s3() {
    if (!_s3Client) _s3Client = new (require('@aws-sdk/client-s3').S3Client)({});
    return _s3Client;
}

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

// Table name a write statement targets, or null if it's not a plain
// INSERT/UPDATE/DELETE (e.g. schema DDL — CREATE/DROP/ALTER/TRUNCATE are
// never mirrored, there's no single-row-file semantic for them).
function writeTargetTable(sql) {
    const m = /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)\s+"?(\w+)"?/i.exec(sql);
    return m ? m[1].toLowerCase() : null;
}

// Re-reads the whole table and overwrites its JSON file, rather than patching
// in just the changed row(s) from a RETURNING clause (many writes in this
// codebase don't use RETURNING at all, e.g. plain DELETEs). A full re-read is
// simpler and self-correcting — it converges to the same result no matter how
// many times or in what order it runs, matching the idempotency requirement
// (feedback-idempotent-writes.md) — at the cost of an extra SELECT per write.
async function mirrorTableToFile(table) {
    const { rows } = await query(`SELECT * FROM ${table} ORDER BY id`);
    const json = JSON.stringify(rows, null, 2);
    if (TRANSACTIONDATA_S3_BUCKET) {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await _s3().send(new PutObjectCommand({
            Bucket: TRANSACTIONDATA_S3_BUCKET, Key: `${table}.json`, Body: json, ContentType: 'application/json',
        }));
    } else {
        fs.mkdirSync(TRANSACTIONDATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(TRANSACTIONDATA_DIR, `${table}.json`), json);
    }
    return rows.length;
}

// Reads back what mirrorTableToFile() last wrote for one table — used by
// GET /api/admin/sync-from-db/download to let an admin actually retrieve the
// synced snapshot when it lives in S3 (no other way to reach it from inside a
// Lambda's read-only deployment package). Returns null if nothing's been
// mirrored for this table yet.
async function readMirroredTableFile(table) {
    if (TRANSACTIONDATA_S3_BUCKET) {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        try {
            const obj = await _s3().send(new GetObjectCommand({ Bucket: TRANSACTIONDATA_S3_BUCKET, Key: `${table}.json` }));
            const chunks = [];
            for await (const chunk of obj.Body) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        } catch (e) {
            if (e.name === 'NoSuchKey') return null;
            throw e;
        }
    }
    const file = path.join(TRANSACTIONDATA_DIR, `${table}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

async function query(sql, params) {
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)/i.test(sql);
    const pool     = isWrite ? writePool : readPool;
    const secretId = isWrite ? WRITE_PASSWORD_SECRET_ID : READ_PASSWORD_SECRET_ID;

    // A rotated password only breaks *new* pool connections (existing sessions
    // survive ALTER ROLE), so an auth failure here means the cached value is
    // stale — drop it and retry once with a freshly fetched password.
    const run = () => withAuthRetry(
        () => pool.query(sql, params),
        () => invalidate(secretId),
    );

    if (isWrite) {
        let result;
        try {
            // Never auto-retry a write on a connectivity failure — the write's
            // outcome is unknown, so a blind retry risks double-applying it.
            // Surface a typed, clean "try again" error instead of the raw pg
            // error; callers are safe to retry only because writes are required
            // to be idempotent (see feedback-idempotent-writes.md).
            result = await run();
        } catch (err) {
            if (!isConnectivityError(err)) throw err;
            const unavailable = new Error('Database temporarily unavailable — please retry shortly.');
            unavailable.dbUnavailable = true;
            unavailable.cause = err;
            throw unavailable;
        }

        const table = writeTargetTable(sql);
        if (table && MIRRORED_TABLES.has(table)) {
            // Best-effort: the DB write already succeeded and is the source of
            // truth — a mirror failure (e.g. read-only filesystem in some
            // deploy target) is logged, never turned into an error response
            // for a write that genuinely succeeded.
            try { await mirrorTableToFile(table); }
            catch (e) { console.error(`[db] mirror-to-file failed for ${table}:`, e.message); }
        }
        return result;
    }

    // Reads: retry transparently through a cold/unreachable DB (e.g. Aurora
    // resuming from scale-to-zero) so a brief hiccup never surfaces to the caller.
    return withConnectRetry(run);
}

// Exposed so tests can monkey-patch .send on the real (never actually
// connected-to) client instance, the same way they override .query on
// writePool/readPool — vi.mock('@aws-sdk/client-s3') does not reliably
// intercept this module's own nested require() of it (same CJS-require
// gotcha documented on writePool/readPool above; confirmed empirically: an
// unmocked run reached real AWS and got a clean NoSuchBucket error).
module.exports = { query, writePool, readPool, mirrorTableToFile, readMirroredTableFile, _s3 };
