const { defineConfig, devices } = require('@playwright/test');

// Set REGRESSION_DB=1 to run against the amaradata-platform_test PostgreSQL database.
// Default (unset) runs in NonDB mode — reads playwright-testdata/ JSON files.
//
//   NonDB (default):  npx playwright test --config=testing/regression_testsuite/playwright.config.js
//   DB mode (Windows): $env:REGRESSION_DB=1; npx playwright test --config=...
//   DB mode (Unix):    REGRESSION_DB=1 npx playwright test --config=...
//
// DB mode requires the _test database to exist and have the schema applied:
//   psql -U postgres -p 5435 -d amaradata-platform_test -f database/schema.sql
const DB_MODE = process.env.REGRESSION_DB === '1';

module.exports = defineConfig({
    testDir:  '.',
    timeout:  30_000,
    retries:  1,
    workers:  1,

    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'testing/regression_testsuite/playwright-report' }],
    ],

    globalSetup:    './global-setup.js',
    globalTeardown: './global-teardown.js',

    use: {
        baseURL:    'http://localhost:9001',
        headless:   true,
        screenshot: 'only-on-failure',
        video:      'retain-on-failure',
        trace:      'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use:  { ...devices['Desktop Chrome'] },
        },
    ],

    webServer: {
        command:             DB_MODE
            ? 'node start-server-db.js'
            : 'node server-entry.js',
        url:                 'http://localhost:9001/api/site-config',
        reuseExistingServer: false,
        timeout:             15_000,
        stdout:              'pipe',
        stderr:              'pipe',
    },
});
