const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

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

    // Split on semicolons while respecting dollar-quoted blocks (DO $$ ... $$).
    // A naive split on ";" would break DO blocks because they contain semicolons inside.
    const statements = splitSql(schema);

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
