// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { evaluateThroughputResult, summarizeThroughputRun, P95_THRESHOLD_MS } from '../../../testing/regression_testsuite/helpers/throughput-runner.js';

describe('evaluateThroughputResult', () => {
    it('passes when p95 is under the SLA and there are no errors', () => {
        const result = evaluateThroughputResult('GET /health', { p95Ms: 50, totalRequests: 1000, errors: 0, non2xx: 0, timeouts: 0 });
        expect(result.pass).toBe(true);
        expect(result.violations).toEqual([]);
    });

    it('fails when p95 exceeds the SLA threshold', () => {
        const result = evaluateThroughputResult('GET /health', { p95Ms: P95_THRESHOLD_MS + 1, totalRequests: 100, errors: 0, non2xx: 0, timeouts: 0 });
        expect(result.pass).toBe(false);
        expect(result.violations[0]).toMatch(/exceeds/);
    });

    it('fails and reports each violation independently (errors, non2xx, timeouts)', () => {
        const result = evaluateThroughputResult('GET /api/x', { p95Ms: 10, totalRequests: 100, errors: 2, non2xx: 3, timeouts: 1 });
        expect(result.pass).toBe(false);
        expect(result.violations).toHaveLength(3);
        expect(result.violations.join(' ')).toMatch(/2 connection error/);
        expect(result.violations.join(' ')).toMatch(/3 non-2xx/);
        expect(result.violations.join(' ')).toMatch(/1 timeout/);
    });
});

describe('summarizeThroughputRun', () => {
    it('summarizes an all-passing run', () => {
        const evaluations = [
            evaluateThroughputResult('a', { p95Ms: 10, totalRequests: 1, errors: 0, non2xx: 0, timeouts: 0 }),
            evaluateThroughputResult('b', { p95Ms: 20, totalRequests: 1, errors: 0, non2xx: 0, timeouts: 0 }),
        ];
        const summary = summarizeThroughputRun(evaluations);
        expect(summary).toEqual({ totalEndpoints: 2, passed: 2, failed: 0, allPassed: true, violations: [] });
    });

    it('collects prefixed violation messages from failing endpoints only', () => {
        const evaluations = [
            evaluateThroughputResult('good', { p95Ms: 10, totalRequests: 1, errors: 0, non2xx: 0, timeouts: 0 }),
            evaluateThroughputResult('bad', { p95Ms: 999, totalRequests: 1, errors: 1, non2xx: 0, timeouts: 0 }),
        ];
        const summary = summarizeThroughputRun(evaluations);
        expect(summary.allPassed).toBe(false);
        expect(summary.failed).toBe(1);
        expect(summary.violations.every((v) => v.startsWith('bad:'))).toBe(true);
        expect(summary.violations).toHaveLength(2); // p95 + error count
    });
});
