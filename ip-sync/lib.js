/**
 * Pure logic for keeping the shared Aurora security group's port-5432 allow-list
 * in step with AWS's published IP ranges for the region.
 *
 * Why this exists: the Lambdas are non-VPC, so they reach Aurora from whatever
 * AWS-owned IP they happen to get, and the security group lists AWS's ranges
 * to allow that. AWS changes the list; hand-maintained rules drift (see
 * scripts/bootstrap-shared-db-infrastructure.js and the 2026-08 / 2026-10
 * connection-timeout incidents).
 *
 * Rules (set by the owner, 2026-10-17):
 *   - Only remove what AWS removed, and only after a grace period (default 14 days).
 *   - Add new ranges until the security group's rule limit is reached.
 *   - Never touch a rule this sync does not own (home IP, undescribed /32s,
 *     security-group references). A rule is "ours" only if its description
 *     starts with "AWS ap-south-1" (the existing hand-made ones) or
 *     "aws-ip-sync" (the ones this job writes).
 *
 * No AWS calls here — see handler.js. Everything is a function of its inputs,
 * so a re-run after a partial failure recomputes the same plan from live state.
 */
'use strict';

const REGION = 'ap-south-1';
// A download that yields fewer EC2 ranges than this is treated as a bad fetch,
// never as "AWS removed everything". (ap-south-1 publishes ~55.)
const MIN_EC2_RANGES = 20;

const MANAGED_DESCRIPTION = /^(AWS ap-south-1|aws-ip-sync)/;
const RETIRE_AFTER = /retire-after:(\d{4}-\d{2}-\d{2})/;
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function assertIpv4Cidr(cidr) {
    const m = IPV4_CIDR.exec(String(cidr));
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) {
        throw new Error(`invalid IPv4 CIDR in AWS ip-ranges: ${JSON.stringify(cidr)}`);
    }
}

function cidrSortKey(cidr) {
    const [ip, len] = cidr.split('/');
    const n = ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
    return [Number(len), n];
}

// Biggest block first (covers the most IPs per rule), then numerically.
function byPriority(a, b) {
    const [la, na] = cidrSortKey(a);
    const [lb, nb] = cidrSortKey(b);
    return la - lb || na - nb;
}

/**
 * @param {{ prefixes: Array<{ip_prefix?: string, region: string, service: string}> }} json  AWS ip-ranges.json
 * @param {string} [region]
 * @returns {{ ec2: string[], other: string[] }}  IPv4 CIDRs for the region, EC2 first-class, everything else as "other"
 */
function parseIpRanges(json, region = REGION) {
    if (!json || !Array.isArray(json.prefixes)) throw new Error('malformed AWS ip-ranges document (no prefixes array)');

    const ec2 = new Set();
    const other = new Set();
    for (const p of json.prefixes) {
        if (!p || !p.ip_prefix || p.region !== region) continue;   // IPv6 entries use ipv6_prefix and are skipped
        assertIpv4Cidr(p.ip_prefix);
        (p.service === 'EC2' ? ec2 : other).add(p.ip_prefix);
    }
    for (const c of ec2) other.delete(c);

    if (ec2.size < MIN_EC2_RANGES) {
        throw new Error(`too few EC2 ranges for ${region} (${ec2.size} < ${MIN_EC2_RANGES}) — refusing to sync from a suspect download`);
    }
    return { ec2: [...ec2].sort(byPriority), other: [...other].sort(byPriority) };
}

const ACTIVE_DESCRIPTION = 'aws-ip-sync EC2';
const retireDescription = (date) => `aws-ip-sync retire-after:${date}`;

/**
 * @param {Array<{ruleId: string, cidr: string|null, description: string|null}>} rules  every inbound rule on the group
 * @returns {{ managed: Array<{ruleId: string, cidr: string, retireAfter: string|null}>, existingCidrs: Set<string>, total: number }}
 */
function classifyRules(rules) {
    const managed = [];
    const existingCidrs = new Set();
    for (const r of rules) {
        if (r.cidr) existingCidrs.add(r.cidr);
        if (!r.cidr || !MANAGED_DESCRIPTION.test(r.description || '')) continue;
        const m = RETIRE_AFTER.exec(r.description || '');
        managed.push({ ruleId: r.ruleId, cidr: r.cidr, retireAfter: m ? m[1] : null });
    }
    return { managed, existingCidrs, total: rules.length };
}

function addDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/**
 * @param {object} p
 * @param {{ec2: string[], other: string[]}} p.desired
 * @param {Array<{ruleId: string, cidr: string|null, description: string|null}>} p.rules
 * @param {string} p.today            YYYY-MM-DD (UTC)
 * @param {number} [p.graceDays=14]
 * @param {number} [p.maxRules=60]    the group's inbound rule quota
 * @param {number} [p.reserveSlots=2] slots filler ranges must leave free so a newly published EC2 range can still be added
 * @param {number} [p.maxRevokesPerRun=15]
 */
function planSync({ desired, rules, today, graceDays = 14, maxRules = 60, reserveSlots = 2, maxRevokesPerRun = 15 }) {
    const { managed, existingCidrs, total } = classifyRules(rules);
    const published = new Set([...desired.ec2, ...desired.other]);   // "removed" = gone from AWS's list entirely

    const markRetire = [];
    const restore = [];
    const due = [];
    for (const m of managed) {
        if (published.has(m.cidr)) {
            if (m.retireAfter) restore.push({ ruleId: m.ruleId, cidr: m.cidr });
        } else if (!m.retireAfter) {
            markRetire.push({ ruleId: m.ruleId, cidr: m.cidr, retireAfter: addDays(today, graceDays) });
        } else if (m.retireAfter <= today) {
            due.push({ ruleId: m.ruleId, cidr: m.cidr, retireAfter: m.retireAfter });
        }
    }
    due.sort((a, b) => a.retireAfter.localeCompare(b.retireAfter) || a.cidr.localeCompare(b.cidr));
    const revoke = due.slice(0, maxRevokesPerRun);
    const deferredRevokes = due.length - revoke.length;

    // Revokes run before adds, so the slots they free are available this run.
    const free = Math.max(0, maxRules - (total - revoke.length));
    const missingEc2 = desired.ec2.filter((c) => !existingCidrs.has(c));
    const addEc2 = missingEc2.slice(0, free);

    const missingOther = desired.other.filter((c) => !existingCidrs.has(c));
    const fillerRoom = Math.max(0, free - addEc2.length - reserveSlots);
    const addOther = missingOther.slice(0, fillerRoom);

    const notCovered = { ec2: missingEc2.length - addEc2.length, other: missingOther.length - addOther.length };
    return {
        add: [...addEc2, ...addOther],
        markRetire,
        restore,
        revoke,
        deferredRevokes,
        notCovered,
        // EC2 ranges are what Lambda egress actually uses; failing to cover one needs a human.
        alarm: notCovered.ec2 > 0,
    };
}

module.exports = {
    REGION, MIN_EC2_RANGES, ACTIVE_DESCRIPTION,
    parseIpRanges, classifyRules, planSync, retireDescription, addDays,
};
