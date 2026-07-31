// @ts-check
/**
 * Playwright config for testing/release-tracking/checks/TC-*.spec.js —
 * verification checks tied to a specific fixed issue (mirrors rohas-group's
 * testing/release-tracking/ structure and release-test-map.json).
 *
 * By default runs locally against an isolated NonDB server (port 9002, its own
 * testdata/ — see server-entry.js / global-setup.js) so these checks are safe
 * to run without touching a real deployed environment or requiring prod
 * credentials. Set PW_BASE_URL to point at a real environment instead (e.g. a
 * staging or production URL) — in that case no local server is started, and
 * you're responsible for auth via SMOKE_TEST_USER/SMOKE_TEST_ADMIN_PASSWORD
 * env vars (same convention as scripts/smoke-prod.js).
 *
 * Usage:
 *   npm run test:release-tracking                                  # local
 *   PW_BASE_URL=https://amaradata.com npm run test:release-tracking # real env
 */
const { defineConfig, devices } = require('@playwright/test');

const REMOTE = !!process.env.PW_BASE_URL;

module.exports = defineConfig({
    testDir: __dirname + '/checks',
    timeout: 60_000,
    retries: 0,
    workers: 1,
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: __dirname + '/playwright-report' }],
    ],
    globalSetup: REMOTE ? undefined : require.resolve('./global-setup.js'),
    use: {
        baseURL:    process.env.PW_BASE_URL || 'http://localhost:9002',
        headless:   true,
        screenshot: 'only-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: REMOTE ? undefined : {
        command:             'node ' + __dirname + '/server-entry.js',
        url:                 'http://localhost:9002/api/site-config',
        reuseExistingServer: false,
        timeout:             15_000,
        stdout:              'pipe',
        stderr:              'pipe',
    },
});
