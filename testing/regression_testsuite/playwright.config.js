const { defineConfig, devices } = require('@playwright/test');

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
        command:             'node server-entry.js',
        url:                 'http://localhost:9001/api/site-config',
        reuseExistingServer: false,
        timeout:             15_000,
        stdout:              'pipe',
        stderr:              'pipe',
    },
});
