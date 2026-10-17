/**
 * Lambda entry point: syncs the shared Aurora security group's port-5432 rules
 * with AWS's published ap-south-1 ranges. Triggered by AWS's own
 * AmazonIpSpaceChanged SNS topic (when AWS changes the list) and by a daily
 * schedule (fallback — an SNS notification can be missed). Both run the same
 * full, idempotent reconcile from live state; the SNS message is never used as
 * data, only as a "go look" signal.
 *
 * Order of operations in one run: revoke expired retired ranges → relabel
 * (retire / restore) → authorize new ranges. Revoking first matters only
 * because the group is at its rule limit; what gets revoked is already gone
 * from AWS's list. A failure throws so Lambda retries and the alarm fires; the
 * next run re-plans from what is actually on the group.
 *
 * DRY_RUN defaults to ON: nothing is changed unless DRY_RUN is explicitly "false".
 */
'use strict';

const { parseIpRanges, planSync, retireDescription, ACTIVE_DESCRIPTION, REGION } = require('./lib');

// Always the canonical URL — never a URL taken from the SNS message.
const IP_RANGES_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
const AUTHORIZE_BATCH = 20;

function loadConfig(env = process.env) {
    if (!env.SECURITY_GROUP_ID) throw new Error('SECURITY_GROUP_ID is required');
    return {
        securityGroupId: env.SECURITY_GROUP_ID,
        targetRegion:    env.TARGET_REGION || REGION,
        dbPort:          Number(env.DB_PORT || 5432),
        maxRules:        Number(env.MAX_RULES || 60),
        reserveSlots:    Number(env.RESERVE_SLOTS ?? 2),
        graceDays:       Number(env.GRACE_DAYS || 14),
        dryRun:          env.DRY_RUN !== 'false',
    };
}

async function fetchIpRanges() {
    const res = await fetch(IP_RANGES_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`ip-ranges.json fetch failed: HTTP ${res.status}`);
    return res.json();
}

const isDuplicate = (err) => err && (err.name === 'InvalidPermission.Duplicate' || err.Code === 'InvalidPermission.Duplicate' || /already exists/i.test(err.message || ''));

async function runSync({ getIpRanges, ec2, now, config, log = console }) {
    const desired = parseIpRanges(await getIpRanges());          // throws on a bad/suspicious download — nothing is touched
    const rules = await ec2.describeInboundRules(config.securityGroupId);
    const today = now().toISOString().slice(0, 10);

    const plan = planSync({
        desired, rules, today,
        graceDays: config.graceDays, maxRules: config.maxRules, reserveSlots: config.reserveSlots,
    });
    const changed = Boolean(plan.add.length || plan.markRetire.length || plan.restore.length || plan.revoke.length);

    log.info(JSON.stringify({
        event: 'ip_sync_plan', dryRun: config.dryRun, securityGroupId: config.securityGroupId, rulesInUse: rules.length,
        add: plan.add, markRetire: plan.markRetire, restore: plan.restore, revoke: plan.revoke,
        deferredRevokes: plan.deferredRevokes, notCovered: plan.notCovered,
    }));
    if (plan.alarm) {
        log.error(JSON.stringify({ event: 'ip_sync_uncovered_ec2', notCovered: plan.notCovered, rulesInUse: rules.length, maxRules: config.maxRules }));
    }
    if (config.dryRun || !changed) return { dryRun: config.dryRun, changed: config.dryRun ? false : changed, plan };

    const { securityGroupId: sg, dbPort } = config;
    if (plan.revoke.length) await ec2.revoke(sg, plan.revoke.map((r) => r.ruleId));
    for (const m of plan.markRetire) await ec2.setDescription(sg, { ruleId: m.ruleId, cidr: m.cidr, description: retireDescription(m.retireAfter) }, dbPort);
    for (const r of plan.restore)    await ec2.setDescription(sg, { ruleId: r.ruleId, cidr: r.cidr, description: ACTIVE_DESCRIPTION }, dbPort);
    for (let i = 0; i < plan.add.length; i += AUTHORIZE_BATCH) {
        try {
            await ec2.authorize(sg, plan.add.slice(i, i + AUTHORIZE_BATCH), dbPort, ACTIVE_DESCRIPTION);
        } catch (err) {
            if (!isDuplicate(err)) throw err;                     // already there → idempotent re-run
        }
    }
    return { dryRun: false, changed: true, plan };
}

/**
 * @param {any} event  SNS or EventBridge schedule event — only logged, never used as input
 * @param {any} _ctx
 * @param {object} [deps]  injectable for tests
 */
async function handler(event, _ctx, deps = {}) {
    const config = deps.config || loadConfig();
    const ec2 = deps.ec2 || require('./ec2-adapter').createEc2Adapter({ region: config.targetRegion });
    const log = deps.log || console;
    const trigger = event && event.Records && event.Records[0] && event.Records[0].Sns ? 'sns' : 'schedule';
    log.info(JSON.stringify({ event: 'ip_sync_start', trigger }));
    return runSync({ getIpRanges: deps.getIpRanges || (() => fetchIpRanges()), ec2, now: deps.now || (() => new Date()), config, log });
}

module.exports = { handler, runSync, loadConfig, IP_RANGES_URL };
