// Starts the app server on port 9002 with isolated NonDB test configuration,
// for testing/release-tracking/checks/TC-*.spec.js.
//
// Deliberately separate from testing/regression_testsuite's port-9001 server and
// testdata: release-tracking checks intentionally create/mutate real-looking
// enhancement records (see feedback-test-data-prefix — zzzzzz-prefixed) and
// should never share state with the general regression suite.
//
// Only used when PW_BASE_URL is not set (i.e. running these checks locally,
// not against a real deployed environment) — see playwright.config.release-checks.js.
const { resolve } = require('path');

process.env.NODE_ENV            = 'test';
process.env.NONDB_MODE          = 'true';
process.env.AMRD_JWT_SECRET     = 'release-checks-test-secret-32ch!!';
process.env.TRANSACTIONDATA_DIR = resolve(__dirname, 'testdata');
process.env.PORT                = '9002';

const app = require('../../server.js');
app.listen(process.env.PORT, () => {
    console.log(`[release-tracking] Test server running on http://localhost:${process.env.PORT}`);
});
