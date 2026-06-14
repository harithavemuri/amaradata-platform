// Runs once after all tests.
// - NonDB mode (default): removes playwright-testdata/ directory.
// - DB mode (REGRESSION_DB=1): asserts _test suffix, cleans up empty result dirs.
const { rmSync, existsSync, readdirSync, statSync, rmdirSync } = require('fs');
const { resolve } = require('path');

const DB_MODE       = process.env.REGRESSION_DB === '1';
const TEST_DATA_DIR = resolve(__dirname, '..', 'playwright-testdata');
const RESULTS_DIR   = resolve(__dirname, 'test-results');

function removeEmptyDirs(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
            removeEmptyDirs(full);
            if (readdirSync(full).length === 0) rmdirSync(full);
        }
    }
    if (readdirSync(dir).length === 0) rmdirSync(dir);
}

module.exports = async function globalTeardown() {
    if (DB_MODE) {
        const dbName = process.env.TEST_DB_NAME || 'amaradata-platform_test';
        if (!dbName.endsWith('_test')) {
            throw new Error(
                `REFUSED: teardown will not run against "${dbName}". ` +
                `Database name must end with _test.`
            );
        }
        removeEmptyDirs(RESULTS_DIR);
        console.log('[teardown] DB mode — cleanup complete.');
    } else {
        try {
            rmSync(TEST_DATA_DIR, { recursive: true, force: true });
            console.log('[teardown] playwright-testdata removed.');
        } catch (err) {
            // Windows can hold file locks briefly after Playwright exits — not a test failure
            if (err.code === 'EPERM' || err.code === 'EBUSY') {
                console.warn('[teardown] Could not remove playwright-testdata (file lock, safe to ignore):', err.message);
            } else {
                throw err;
            }
        }
    }
};
