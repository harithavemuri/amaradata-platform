// Launcher for DB-mode regression runs (the default — see playwright.config.js).
// Sets NONDB_MODE=false and points the server at the _test database.
process.env.NODE_ENV         = 'test';
process.env.NONDB_MODE       = 'false';
process.env.AMRD_DB_HOST     = process.env.TEST_DB_HOST     || 'localhost';
process.env.AMRD_DB_PORT     = process.env.TEST_DB_PORT     || '5435';
process.env.AMRD_DB_NAME     = process.env.TEST_DB_NAME     || 'amaradata-platform_test';
process.env.AMRD_DB_USER     = process.env.TEST_DB_USER     || 'postgres';
process.env.AMRD_DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'AccuSync892';
process.env.AMRD_JWT_SECRET  = 'playwright-test-secret-32chars!!';
process.env.PORT             = '9001';

// backend/db.js mirrors every successful write to transactiondata/<table>.json
// (see project-db-write-file-mirror.md) — redirect it so DB-mode regression
// runs never overwrite the real, committed transactiondata/ files.
const { resolve } = require('path');
process.env.TRANSACTIONDATA_DIR = resolve(__dirname, '..', 'playwright-testdata');

const app = require('../../server.js');
app.listen(process.env.PORT, () => {
    console.log(`[playwright] Test server (DB mode) on http://localhost:${process.env.PORT}`);
});
