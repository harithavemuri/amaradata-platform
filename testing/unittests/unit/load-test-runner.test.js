// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildWorkerEnv, summarizeLoadTestResults } from '../../../testing/regression_testsuite/helpers/load-test-runner.js';

describe('buildWorkerEnv', () => {
    it('adds LOAD_TEST_USER_INDEX without mutating the base env', () => {
        const base = { PATH: '/usr/bin', FOO: 'bar' };
        const env = buildWorkerEnv(3, base);
        expect(env.LOAD_TEST_USER_INDEX).toBe('3');
        expect(env.PATH).toBe('/usr/bin');
        expect(env.FOO).toBe('bar');
        expect(base.LOAD_TEST_USER_INDEX).toBeUndefined(); // base untouched
    });
});

describe('summarizeLoadTestResults', () => {
    it('reports all-passed when every process exits 0', () => {
        const results = [{ userIndex: 0, exitCode: 0 }, { userIndex: 1, exitCode: 0 }];
        expect(summarizeLoadTestResults(results)).toEqual({
            totalProcesses: 2, passedCount: 2, failedCount: 0, allPassed: true, failedUserIndices: [],
        });
    });

    it('lists failed user indices when some processes exit non-zero', () => {
        const results = [{ userIndex: 0, exitCode: 0 }, { userIndex: 1, exitCode: 1 }, { userIndex: 2, exitCode: 0 }];
        expect(summarizeLoadTestResults(results)).toEqual({
            totalProcesses: 3, passedCount: 2, failedCount: 1, allPassed: false, failedUserIndices: [1],
        });
    });

    it('treats a null exit code (process killed) as a failure', () => {
        const results = [{ userIndex: 0, exitCode: null }];
        const summary = summarizeLoadTestResults(results);
        expect(summary.allPassed).toBe(false);
        expect(summary.failedUserIndices).toEqual([0]);
    });
});
