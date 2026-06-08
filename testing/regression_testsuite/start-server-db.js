// Launcher for DB-mode regression runs (REGRESSION_DB=1).
// Sets NONDB_MODE=false and points the server at the _test database.
// Invoked by playwright.config.js when REGRESSION_DB=1 is set.
process.env.NODE_ENV         = 'test';
process.env.NONDB_MODE       = 'false';
process.env.AMRD_DB_HOST     = process.env.TEST_DB_HOST     || 'localhost';
process.env.AMRD_DB_PORT     = process.env.TEST_DB_PORT     || '5435';
process.env.AMRD_DB_NAME     = process.env.TEST_DB_NAME     || 'amaradata-platform_test';
process.env.AMRD_DB_USER     = process.env.TEST_DB_USER     || 'postgres';
process.env.AMRD_DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'AccuSync892';
process.env.AMRD_JWT_SECRET  = 'playwright-test-secret-32chars!!';
process.env.PORT             = '9001';

const app = require('../../server.js');
app.listen(process.env.PORT, () => {
    console.log(`[playwright] Test server (DB mode) on http://localhost:${process.env.PORT}`);
});
