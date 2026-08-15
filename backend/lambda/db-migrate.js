const { Pool }             = require('pg');
const fs                   = require('fs');
const path                 = require('path');
const { withConnectRetry } = require('../services/db-retry');

// Split SQL into individual statements, correctly handling:
//   - single-line comments  (-- ...)        semicolons inside are not delimiters
//   - single-quoted strings ('...' / '...'' escape)  same
//   - dollar-quoted blocks  ($$ ... $$)     same (used by DO blocks)
function splitSql(sql) {
    const stmts = [];
    let current = '';
    let i = 0;
    let inDollarQuote = false;
    let dollarTag = '';
    let inSingleQuote = false;

    while (i < sql.length) {
        const ch = sql[i];

        // ── inside dollar-quoted block ────────────────────────────────────────
        if (inDollarQuote) {
            if (sql.slice(i).startsWith(dollarTag)) {
                inDollarQuote = false;
                current += dollarTag;
                i += dollarTag.length;
            } else {
                current += ch;
                i++;
            }
            continue;
        }

        // ── inside single-quoted string ───────────────────────────────────────
        if (inSingleQuote) {
            if (ch === "'" && sql[i + 1] === "'") {   // '' escape sequence
                current += "''";
                i += 2;
            } else if (ch === "'") {
                inSingleQuote = false;
                current += ch;
                i++;
            } else {
                current += ch;
                i++;
            }
            continue;
        }

        // ── unquoted context ──────────────────────────────────────────────────

        // single-line comment: consume to end of line without splitting on ;
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') current += sql[i++];
            continue;
        }

        // opening single quote
        if (ch === "'") {
            inSingleQuote = true;
            current += ch;
            i++;
            continue;
        }

        // opening dollar-quote tag (e.g. $$ or $body$)
        const tagMatch = sql.slice(i).match(/^\$([A-Za-z_]*)\$/);
        if (tagMatch) {
            dollarTag     = tagMatch[0];
            inDollarQuote = true;
            current      += dollarTag;
            i            += dollarTag.length;
            continue;
        }

        // statement delimiter
        if (ch === ';') {
            const stmt = current.trim();
            if (stmt) stmts.push(stmt);
            current = '';
            i++;
            continue;
        }

        current += ch;
        i++;
    }
    const last = current.trim();
    if (last) stmts.push(last);
    return stmts;
}

exports.handler = async () => {
    // The Lambda is VPC-attached (same VPC/subnets as Aurora) and has no route to
    // Secrets Manager's public endpoint, so the password is resolved once at CFN
    // deploy time via {{resolve:secretsmanager:...}} in template.yaml's Environment
    // block instead of a runtime GetSecretValue call.
    const password = (process.env.DB_MASTER_PASSWORD || '').trim();
    const user     = process.env.DB_MASTER_USER || 'postgres';

    // Per-attempt timeout is shorter than the old single 60000ms shot: DBMigrateFn
    // has a 120s Lambda timeout (template.yaml), and a cold Aurora Serverless v2
    // resume can take up to ~30s, so several shorter attempts recover faster and
    // still fit the budget (3 attempts x 20s connect + backoff <= ~75s, leaving
    // room to actually run the migration). scripts/db-migrate.js's own retry loop
    // (re-invoking this whole Lambda up to 3x with a 30s wait) is a second,
    // outer line of defense on top of this — not a replacement for it.
    const pool = new Pool({
        host:                   process.env.AMRD_DB_HOST,
        port:                   5432,
        database:               process.env.AMRD_DB_NAME,
        user,
        password,
        max:                    2,
        connectionTimeoutMillis: 20000,
    });

    const schema = fs.readFileSync(
        path.join(__dirname, '../../database/schema.sql'), 'utf8'
    );

    // Split on semicolons while respecting dollar-quoted blocks (DO $$ ... $$).
    // A naive split on ";" would break DO blocks because they contain semicolons inside.
    const statements = splitSql(schema);

    let ran = 0, errs = [];
    const client = await withConnectRetry(
        () => pool.connect(),
        { retries: 3, delayMs: 5000, onRetry: (err, attempt) =>
            console.warn(`[db-migrate] connectivity error on attempt ${attempt}, retrying: ${err.message}`) },
    );
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

module.exports.splitSql = splitSql;
