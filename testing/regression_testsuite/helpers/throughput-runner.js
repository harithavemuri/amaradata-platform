// @ts-check
/**
 * Pure evaluation logic for scripts/run-throughput-test.js — kept dependency-
 * free (no autocannon/child_process imports) so it can be unit tested
 * directly. See testing/unittests/unit/throughput-runner.test.js.
 *
 * SLA per feedback-performance-sla.md: API responses <=500ms. autocannon has
 * no exact p95 bucket — p97_5 (its next percentile up) is used as a slightly
 * more conservative stand-in, same as rohas-group's version.
 */

'use strict';

const P95_THRESHOLD_MS = 500;

/**
 * @param {string} label
 * @param {{p95Ms: number, totalRequests: number, errors: number, non2xx: number, timeouts: number}} result
 */
function evaluateThroughputResult(label, result) {
    const violations = [];
    if (result.p95Ms > P95_THRESHOLD_MS) violations.push(`p95 ${result.p95Ms}ms exceeds ${P95_THRESHOLD_MS}ms SLA`);
    if (result.errors > 0) violations.push(`${result.errors} connection error(s)`);
    if (result.non2xx > 0) violations.push(`${result.non2xx} non-2xx response(s)`);
    if (result.timeouts > 0) violations.push(`${result.timeouts} timeout(s)`);

    return {
        label,
        pass: violations.length === 0,
        violations,
        ...result,
    };
}

/**
 * @param {Array<ReturnType<typeof evaluateThroughputResult>>} evaluations
 */
function summarizeThroughputRun(evaluations) {
    const failed = evaluations.filter((e) => !e.pass);
    return {
        totalEndpoints: evaluations.length,
        passed: evaluations.length - failed.length,
        failed: failed.length,
        allPassed: failed.length === 0,
        violations: failed.flatMap((e) => e.violations.map((v) => `${e.label}: ${v}`)),
    };
}

module.exports = { P95_THRESHOLD_MS, evaluateThroughputResult, summarizeThroughputRun };
