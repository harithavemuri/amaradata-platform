// @ts-check
/**
 * Pure logic for scripts/run-load-test.js — kept dependency-free (no
 * child_process/Playwright imports) so it can be unit tested directly. See
 * testing/unittests/unit/load-test-runner.test.js.
 *
 * Unlike rohas-group's version, amaradata's edit-save specs avoid data
 * collisions between concurrent processes via helpers/edit-save.js's
 * uniqueSuffix() (timestamp + random), not by routing each process to a
 * distinct pre-seeded data row — amaradata has no per-worker row-picking
 * concept to port. LOAD_TEST_USER_INDEX is still set on each worker's env for
 * identification/logging (visible in each process's console prefix) and as a
 * hook for any future test that does need per-worker isolation.
 */

'use strict';

/**
 * @param {number} userIndex
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
function buildWorkerEnv(userIndex, baseEnv) {
    return { ...baseEnv, LOAD_TEST_USER_INDEX: String(userIndex) };
}

/**
 * @param {Array<{userIndex: number, exitCode: number|null}>} results
 */
function summarizeLoadTestResults(results) {
    const failed = results.filter((r) => r.exitCode !== 0);
    return {
        totalProcesses: results.length,
        passedCount: results.length - failed.length,
        failedCount: failed.length,
        allPassed: failed.length === 0,
        failedUserIndices: failed.map((r) => r.userIndex),
    };
}

module.exports = { buildWorkerEnv, summarizeLoadTestResults };
