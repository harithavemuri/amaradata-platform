// @vitest-environment node
/**
 * ip-sync/lib.js — pure logic for keeping the shared Aurora security group's
 * port-5432 allow-list in step with AWS's published ap-south-1 ranges.
 *
 * Rules the user set (2026-10-17):
 *   - only remove what AWS removed (after a 14-day grace period)
 *   - add new ranges to fill the security group's 60-rule limit
 *   - never lose the non-AWS rules (home IP, undescribed /32s, SG-to-SG rules)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const lib = require_('../../../ip-sync/lib.js');
const { parseIpRanges, classifyRules, planSync, retireDescription, MIN_EC2_RANGES } = lib;

const TODAY = '2026-10-17';

// ── fixtures ────────────────────────────────────────────────────────────────
function ec2Cidrs(n, base = 10) { return Array.from({ length: n }, (_, i) => `${base}.${i}.0.0/24`); }
function aws(prefixes) { return { createDate: '2026-10-17-11-07-06', prefixes }; }
function rule(id, cidr, description) { return { ruleId: id, cidr, description }; }
const managedRule = (i, cidr, extra = '') => rule(`sgr-m${i}`, cidr, `AWS ap-south-1 (EC2)${extra}`);

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — parseIpRanges()', () => {
    const sample = aws([
        ...ec2Cidrs(MIN_EC2_RANGES).map((p) => ({ ip_prefix: p, region: 'ap-south-1', service: 'EC2' })),
        { ip_prefix: '3.6.0.0/15',   region: 'ap-south-1', service: 'AMAZON' },
        { ip_prefix: '3.7.0.0/16',   region: 'ap-south-1', service: 'AMAZON' },
        { ip_prefix: '10.0.0.0/24',  region: 'ap-south-1', service: 'AMAZON' },   // duplicate of an EC2 cidr
        { ip_prefix: '52.0.0.0/16',  region: 'us-east-1',  service: 'EC2' },      // wrong region
    ]);

    it('splits ap-south-1 ranges into EC2 and other-service, dropping other regions and duplicates', () => {
        const { ec2, other } = parseIpRanges(sample);
        expect(ec2).toHaveLength(MIN_EC2_RANGES);
        expect(ec2).not.toContain('52.0.0.0/16');
        expect(other).toEqual(['3.6.0.0/15', '3.7.0.0/16']);   // /15 before /16: bigger block first
    });

    it('orders EC2 ranges biggest block first, then numerically', () => {
        const j = aws([
            ...ec2Cidrs(MIN_EC2_RANGES, 20).map((p) => ({ ip_prefix: p, region: 'ap-south-1', service: 'EC2' })),
            { ip_prefix: '13.200.0.0/14', region: 'ap-south-1', service: 'EC2' },
        ]);
        const { ec2 } = parseIpRanges(j);
        expect(ec2[0]).toBe('13.200.0.0/14');
    });

    it('ignores IPv6 entries (security-group IPv4 rules only)', () => {
        const j = aws([
            ...ec2Cidrs(MIN_EC2_RANGES).map((p) => ({ ip_prefix: p, region: 'ap-south-1', service: 'EC2' })),
            { ipv6_prefix: '2600:1f00::/40', region: 'ap-south-1', service: 'EC2' },
        ]);
        expect(parseIpRanges(j).ec2).toHaveLength(MIN_EC2_RANGES);
    });

    it('throws on a malformed document (never plan from garbage)', () => {
        expect(() => parseIpRanges(null)).toThrow();
        expect(() => parseIpRanges({})).toThrow();
        expect(() => parseIpRanges({ prefixes: 'nope' })).toThrow();
    });

    it('throws when suspiciously few EC2 ranges come back (a bad download must not look like "AWS removed everything")', () => {
        const j = aws(ec2Cidrs(MIN_EC2_RANGES - 1).map((p) => ({ ip_prefix: p, region: 'ap-south-1', service: 'EC2' })));
        expect(() => parseIpRanges(j)).toThrow(/too few/i);
    });

    it('throws on a prefix that is not a valid IPv4 CIDR', () => {
        const j = aws([
            ...ec2Cidrs(MIN_EC2_RANGES).map((p) => ({ ip_prefix: p, region: 'ap-south-1', service: 'EC2' })),
            { ip_prefix: 'not-a-cidr', region: 'ap-south-1', service: 'EC2' },
        ]);
        expect(() => parseIpRanges(j)).toThrow(/invalid/i);
    });
});

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — classifyRules()', () => {
    it('treats only AWS-described CIDR rules as managed', () => {
        const { managed } = classifyRules([
            rule('1', '1.2.3.0/24', 'AWS ap-south-1 (EC2)'),
            rule('2', '1.2.4.0/24', 'AWS ap-south-1'),
            rule('3', '1.2.5.0/24', 'aws-ip-sync EC2'),
            rule('4', '96.231.55.86/32', 'Home pgAdmin'),
            rule('5', '195.229.45.88/32', null),
            rule('6', null, 'amaradata-prod DBMigrateFn (VPC-attached schema migration)'),   // SG reference
        ]);
        expect(managed.map((m) => m.ruleId)).toEqual(['1', '2', '3']);
    });

    it('reads the retire-after date from a retiring rule', () => {
        const { managed } = classifyRules([rule('1', '1.2.3.0/24', retireDescription('2026-10-31'))]);
        expect(managed[0].retireAfter).toBe('2026-10-31');
    });

    it('a manual AWS-looking rule (e.g. the 2026-10-12 Lambda/EC2 range) is managed too', () => {
        const { managed } = classifyRules([rule('1', '1.2.3.0/24', 'AWS ap-south-1 Lambda/EC2 range published 2026-10-12 (rohas intermittent login timeouts)')]);
        expect(managed).toHaveLength(1);
    });
});

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — planSync()', () => {
    const desired = { ec2: ec2Cidrs(10), other: ['3.6.0.0/15', '3.7.0.0/16', '3.8.0.0/16'] };
    const base = { desired, today: TODAY, graceDays: 14, maxRules: 60, reserveSlots: 2 };

    it('in step already → no changes', () => {
        const rules = desired.ec2.map((c, i) => managedRule(i, c));
        const plan = planSync({ ...base, rules, maxRules: rules.length + 5, reserveSlots: 5 });
        expect(plan).toMatchObject({ add: [], markRetire: [], restore: [], revoke: [] });
    });

    it('a range AWS removed is marked to retire in 14 days, NOT revoked immediately', () => {
        const rules = [...desired.ec2.map((c, i) => managedRule(i, c)), managedRule(99, '64.73.214.0/24')];
        const plan = planSync({ ...base, rules });
        expect(plan.markRetire).toEqual([{ ruleId: 'sgr-m99', cidr: '64.73.214.0/24', retireAfter: '2026-10-31' }]);
        expect(plan.revoke).toEqual([]);
    });

    it('a retiring range is kept until its date has passed, then revoked', () => {
        const rules = [...desired.ec2.map((c, i) => managedRule(i, c)),
            rule('sgr-r1', '64.73.214.0/24', retireDescription('2026-10-17')),   // due today → revoke
            rule('sgr-r2', '64.73.215.0/24', retireDescription('2026-10-18'))];  // tomorrow → keep
        const plan = planSync({ ...base, rules });
        expect(plan.revoke.map((r) => r.ruleId)).toEqual(['sgr-r1']);
        expect(plan.markRetire).toEqual([]);
    });

    it('a retiring range that AWS publishes again is restored, never revoked', () => {
        const back = desired.ec2[0];
        const rules = [rule('sgr-x', back, retireDescription('2026-10-01')), ...desired.ec2.slice(1).map((c, i) => managedRule(i, c))];
        const plan = planSync({ ...base, rules });
        expect(plan.restore).toEqual([{ ruleId: 'sgr-x', cidr: back }]);
        expect(plan.revoke).toEqual([]);
    });

    it('NEVER touches non-AWS rules: home IP, undescribed /32, SG-reference rules', () => {
        const rules = [
            rule('home', '96.231.55.86/32', 'Home pgAdmin'),
            rule('nodesc', '195.229.45.88/32', null),
            rule('sgref', null, 'amaradata-prod DBMigrateFn (VPC-attached schema migration)'),
            ...desired.ec2.map((c, i) => managedRule(i, c)),
        ];
        const plan = planSync({ ...base, rules });
        const touched = [...plan.markRetire, ...plan.revoke, ...plan.restore].map((x) => x.ruleId);
        expect(touched).not.toContain('home');
        expect(touched).not.toContain('nodesc');
        expect(touched).not.toContain('sgref');
    });

    it('never touches a non-AWS rule even when its date has "expired" or its CIDR is not an AWS range', () => {
        const rules = [rule('nodesc', '195.229.45.88/32', 'retire-after:2020-01-01'), ...desired.ec2.map((c, i) => managedRule(i, c))];
        const plan = planSync({ ...base, rules });
        expect(plan.revoke).toEqual([]);
        expect(plan.markRetire).toEqual([]);
    });

    it('does not remove a range that is only in another AWS service tag (removed means gone from AWS entirely)', () => {
        const rules = [...desired.ec2.map((c, i) => managedRule(i, c)), managedRule(50, '3.6.0.0/15')];
        const plan = planSync({ ...base, rules });
        expect(plan.markRetire).toEqual([]);
    });

    it('adds missing EC2 ranges, biggest first, only up to the free slots', () => {
        const rules = ec2Cidrs(10).slice(0, 4).map((c, i) => managedRule(i, c));
        const plan = planSync({ ...base, rules, maxRules: 6, reserveSlots: 0 });
        expect(plan.add).toEqual(desired.ec2.slice(4, 6));                // only 2 slots free
        expect(plan.notCovered.ec2).toBe(4);
        expect(plan.alarm).toBe(true);
    });

    it('fills the remaining slots with other-service ranges, but keeps the reserve for future EC2 ranges', () => {
        const rules = desired.ec2.map((c, i) => managedRule(i, c));      // all 10 EC2 present
        const plan = planSync({ ...base, rules, maxRules: 14, reserveSlots: 2 });
        expect(plan.add).toEqual(['3.6.0.0/15', '3.7.0.0/16']);          // 4 free - 2 reserved = 2 filler
        expect(plan.alarm).toBe(false);
    });

    it('EC2 ranges may use the reserved slots; filler may not', () => {
        const rules = desired.ec2.slice(0, 9).map((c, i) => managedRule(i, c));   // 1 EC2 missing
        const plan = planSync({ ...base, rules, maxRules: 11, reserveSlots: 2 });
        expect(plan.add).toEqual([desired.ec2[9]]);                      // EC2 takes 1 of 2 free, filler gets none
    });

    it('counts non-AWS and SG-reference rules against the limit', () => {
        const rules = [
            rule('home', '96.231.55.86/32', 'Home pgAdmin'),
            rule('sgref', null, 'DBMigrateFn'),
            ...desired.ec2.slice(0, 8).map((c, i) => managedRule(i, c)),
        ];                                                               // 10 rules in use
        const plan = planSync({ ...base, rules, maxRules: 11, reserveSlots: 0 });
        expect(plan.add).toHaveLength(1);
    });

    it('frees slots by revoking expired ranges first, and fills them the same run', () => {
        const rules = [...desired.ec2.slice(0, 9).map((c, i) => managedRule(i, c)),
            rule('sgr-gone', '64.73.214.0/24', retireDescription('2026-10-01'))];     // 10 in use, limit 10
        const plan = planSync({ ...base, rules, maxRules: 10, reserveSlots: 0 });
        expect(plan.revoke.map((r) => r.ruleId)).toEqual(['sgr-gone']);
        expect(plan.add).toEqual([desired.ec2[9]]);
    });

    it('does not add a CIDR that already exists under a non-managed rule (would be a duplicate)', () => {
        const rules = [rule('mine', desired.ec2[0], 'someone added this by hand'), ...desired.ec2.slice(1).map((c, i) => managedRule(i, c))];
        const plan = planSync({ ...base, rules, maxRules: 60 });
        expect(plan.add).not.toContain(desired.ec2[0]);
    });

    it('caps revocations per run and reports what was deferred', () => {
        const stale = Array.from({ length: 20 }, (_, i) => rule(`sgr-s${i}`, `192.0.${i}.0/24`, retireDescription('2026-10-01')));
        const plan = planSync({ ...base, rules: [...desired.ec2.map((c, i) => managedRule(i, c)), ...stale], maxRevokesPerRun: 15 });
        expect(plan.revoke).toHaveLength(15);
        expect(plan.deferredRevokes).toBe(5);
    });

    it('is idempotent: applying a plan and re-planning yields an empty plan', () => {
        const rules = ec2Cidrs(10).slice(0, 5).map((c, i) => managedRule(i, c));
        const p1 = planSync({ ...base, rules, maxRules: 60, reserveSlots: 0 });
        const after = [...rules, ...p1.add.map((c, i) => managedRule(100 + i, c))];
        const p2 = planSync({ ...base, rules: after, maxRules: 60, reserveSlots: 0 });
        expect(p2.add).toEqual([]);
        expect(p2.markRetire).toEqual([]);
        expect(p2.revoke).toEqual([]);
    });
});
