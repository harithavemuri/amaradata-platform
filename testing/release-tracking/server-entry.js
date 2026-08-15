// Starts the app server on port 9002 against the real amaradata-platform_test
// Postgres DB, for testing/release-tracking/checks/TC-*.spec.js.
//
// Was NonDB mode until NonDB mode became read-only (see project-nondb-read-only.md)
// — these checks intentionally create/mutate real-looking enhancement records
// (see feedback-test-data-prefix — zzzzzz-prefixed), which only works against a
// real DB now. Deliberately separate from testing/regression_testsuite's port-9001
// server: release-tracking checks should never share state with the general
// regression suite, so this points at the same _test DB but relies on
// global-setup.js's TRUNCATE to keep the two runs from seeing each other's data
// (they run sequentially in npm run test:all, never concurrently).
//
// Only used when PW_BASE_URL is not set (i.e. running these checks locally,
// not against a real deployed environment) — see playwright.config.release-checks.js.
const { resolve } = require('path');
const { testDb }  = require('../../src/test/test-db-config.js');

if (!testDb.database.endsWith('_test')) {
    throw new Error(
        `REFUSED: release-tracking checks will not run against "${testDb.database}". ` +
        `Database name must end with _test.`
    );
}

process.env.NODE_ENV         = 'test';
process.env.NONDB_MODE       = 'false';
process.env.AMRD_JWT_SECRET  = 'release-checks-test-secret-32ch!!';
process.env.AMRD_DB_HOST     = testDb.host;
process.env.AMRD_DB_PORT     = String(testDb.port);
process.env.AMRD_DB_NAME     = testDb.database;
process.env.AMRD_DB_USER     = testDb.user;
process.env.AMRD_DB_PASSWORD = testDb.password;
process.env.PORT             = '9002';

// backend/db.js mirrors every successful write to transactiondata/<table>.json
// (see project-db-write-file-mirror.md) — redirect it so this run never
// overwrites the real, committed transactiondata/ files.
process.env.TRANSACTIONDATA_DIR = resolve(__dirname, 'testdata');

const app = require('../../server.js');
app.listen(process.env.PORT, () => {
    console.log(`[release-tracking] Test server running on http://localhost:${process.env.PORT}`);
});
