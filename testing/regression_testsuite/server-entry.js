// Starts the app server on port 9001 with isolated test configuration.
// Used by Playwright's webServer option — do not run this directly for dev.
const { resolve } = require('path');

process.env.NODE_ENV            = 'test';
process.env.NONDB_MODE          = 'true';
process.env.AMRD_JWT_SECRET     = 'playwright-test-secret-32chars!!';
// Absolute path so it resolves correctly regardless of CWD
process.env.TRANSACTIONDATA_DIR = resolve(__dirname, '..', 'playwright-testdata');
process.env.PORT                = '9001';

const app = require('../../server.js');
app.listen(process.env.PORT, () => {
    console.log(`[playwright] Test server running on http://localhost:${process.env.PORT}`);
});
