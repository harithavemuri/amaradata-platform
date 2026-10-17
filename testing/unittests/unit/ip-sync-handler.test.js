// @vitest-environment node
/**
 * ip-sync/handler.js — orchestration around lib.js: fetch AWS ranges, read the
 * security group, plan, apply (revoke → relabel → authorize), and the thin
 * EC2 adapter. AWS and the network are injected; nothing here touches AWS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { runSync, loadConfig, handler } = require_('../../../ip-sync/handler.js');
const { createEc2Adapter } = require_('../../../ip-sync/ec2-adapter.js');
const { MIN_EC2_RANGES, retireDescription } = require_('../../../ip-sync/lib.js');

const SG = 'sg-test';
const NOW = () => new Date('2026-10-17T03:00:00Z');

function awsJson(ec2 = MIN_EC2_RANGES, extra = []) {
    return {
        prefixes: [
            ...Array.from({ length: ec2 }, (_, i) => ({ ip_prefix: `10.${i}.0.0/24`, region: 'ap-south-1', service: 'EC2' })),
            ...extra,
        ],
    };
}
const managed = (i, cidr, desc = 'AWS ap-south-1 (EC2)') => ({ ruleId: `sgr-${i}`, cidr, description: desc });
const inSync = () => Array.from({ length: MIN_EC2_RANGES }, (_, i) => managed(i, `10.${i}.0.0/24`));

function fakeEc2(rules) {
    return {
        describeInboundRules: vi.fn().mockResolvedValue(rules),
        revoke: vi.fn().mockResolvedValue(),
        setDescription: vi.fn().mockResolvedValue(),
        authorize: vi.fn().mockResolvedValue(),
    };
}
const config = (over = {}) => ({ securityGroupId: SG, dryRun: false, maxRules: 60, reserveSlots: 2, graceDays: 14, dbPort: 5432, ...over });
const silent = { info: () => {}, error: () => {} };

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — runSync()', () => {
    let ec2;
    beforeEach(() => { ec2 = fakeEc2(inSync()); });

    it('in step → reads, changes nothing', async () => {
        const out = await runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config({ maxRules: MIN_EC2_RANGES }), log: silent });
        expect(ec2.revoke).not.toHaveBeenCalled();
        expect(ec2.authorize).not.toHaveBeenCalled();
        expect(ec2.setDescription).not.toHaveBeenCalled();
        expect(out.changed).toBe(false);
    });

    it('dry run (the default posture): reports the plan but makes no mutating call', async () => {
        const rules = [...inSync(), managed(99, '64.73.214.0/24'), { ruleId: 'sgr-home', cidr: '96.231.55.86/32', description: 'Home pgAdmin' }];
        ec2 = fakeEc2(rules);
        const out = await runSync({ getIpRanges: async () => awsJson(MIN_EC2_RANGES + 1), ec2, now: NOW, config: config({ dryRun: true }), log: silent });
        expect(out.dryRun).toBe(true);
        expect(out.plan.markRetire).toHaveLength(1);
        expect(out.plan.add).toHaveLength(1);
        expect(ec2.revoke).not.toHaveBeenCalled();
        expect(ec2.authorize).not.toHaveBeenCalled();
        expect(ec2.setDescription).not.toHaveBeenCalled();
    });

    it('marks a range AWS removed as retiring in 14 days (relabel only — nothing revoked yet)', async () => {
        ec2 = fakeEc2([...inSync(), managed(99, '64.73.214.0/24')]);
        await runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config(), log: silent });
        expect(ec2.setDescription).toHaveBeenCalledWith(SG, { ruleId: 'sgr-99', cidr: '64.73.214.0/24', description: retireDescription('2026-10-31') }, 5432);
        expect(ec2.revoke).not.toHaveBeenCalled();
    });

    it('revokes a retired range once its date passed, THEN authorizes new ranges into the freed slot', async () => {
        const calls = [];
        const rules = [...inSync(), { ruleId: 'sgr-old', cidr: '64.73.214.0/24', description: retireDescription('2026-10-01') }];
        ec2 = fakeEc2(rules);
        ec2.revoke.mockImplementation(async () => { calls.push('revoke'); });
        ec2.authorize.mockImplementation(async () => { calls.push('authorize'); });
        await runSync({ getIpRanges: async () => awsJson(MIN_EC2_RANGES + 1), ec2, now: NOW, config: config({ maxRules: MIN_EC2_RANGES + 1, reserveSlots: 0 }), log: silent });
        expect(ec2.revoke).toHaveBeenCalledWith(SG, ['sgr-old']);
        expect(ec2.authorize).toHaveBeenCalledWith(SG, [`10.${MIN_EC2_RANGES}.0.0/24`], 5432, 'aws-ip-sync EC2');
        expect(calls).toEqual(['revoke', 'authorize']);
    });

    it('restores a retiring range AWS publishes again', async () => {
        ec2 = fakeEc2([{ ruleId: 'sgr-0', cidr: '10.0.0.0/24', description: retireDescription('2026-10-25') }, ...inSync().slice(1)]);
        await runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config({ maxRules: MIN_EC2_RANGES }), log: silent });
        expect(ec2.setDescription).toHaveBeenCalledWith(SG, { ruleId: 'sgr-0', cidr: '10.0.0.0/24', description: 'aws-ip-sync EC2' }, 5432);
        expect(ec2.revoke).not.toHaveBeenCalled();
    });

    it('never passes a non-AWS rule to revoke or relabel', async () => {
        const rules = [
            ...inSync(),
            { ruleId: 'sgr-home', cidr: '96.231.55.86/32', description: 'Home pgAdmin' },
            { ruleId: 'sgr-nodesc', cidr: '195.229.45.88/32', description: null },
            { ruleId: 'sgr-ref', cidr: null, description: 'DBMigrateFn' },
        ];
        ec2 = fakeEc2(rules);
        await runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config(), log: silent });
        const ids = [...ec2.revoke.mock.calls.flatMap(([, i]) => i), ...ec2.setDescription.mock.calls.map(([, r]) => r.ruleId)];
        expect(ids).not.toEqual(expect.arrayContaining(['sgr-home']));
        expect(ids).not.toContain('sgr-nodesc');
        expect(ids).not.toContain('sgr-ref');
    });

    it('authorizes in batches of at most 20', async () => {
        ec2 = fakeEc2([]);
        await runSync({ getIpRanges: async () => awsJson(45), ec2, now: NOW, config: config({ maxRules: 60, reserveSlots: 0 }), log: silent });
        const sizes = ec2.authorize.mock.calls.map(([, cidrs]) => cidrs.length);
        expect(sizes).toEqual([20, 20, 5]);
    });

    it('treats "duplicate rule" from AWS as already done (idempotent re-run)', async () => {
        ec2 = fakeEc2(inSync().slice(1));
        ec2.authorize.mockRejectedValue(Object.assign(new Error('The specified rule already exists'), { name: 'InvalidPermission.Duplicate' }));
        await expect(runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config(), log: silent })).resolves.toBeDefined();
    });

    it('rethrows any other AWS failure so Lambda retries / alarms (the next run re-plans from live state)', async () => {
        ec2 = fakeEc2(inSync().slice(1));
        ec2.authorize.mockRejectedValue(Object.assign(new Error('boom'), { name: 'RulesPerSecurityGroupLimitExceeded' }));
        await expect(runSync({ getIpRanges: async () => awsJson(), ec2, now: NOW, config: config(), log: silent })).rejects.toThrow('boom');
    });

    it('a failed or suspicious AWS download changes nothing', async () => {
        await expect(runSync({ getIpRanges: async () => { throw new Error('network'); }, ec2, now: NOW, config: config(), log: silent })).rejects.toThrow('network');
        await expect(runSync({ getIpRanges: async () => awsJson(3), ec2, now: NOW, config: config(), log: silent })).rejects.toThrow(/too few/i);
        expect(ec2.describeInboundRules).not.toHaveBeenCalled();
        expect(ec2.revoke).not.toHaveBeenCalled();
        expect(ec2.authorize).not.toHaveBeenCalled();
    });

    it('logs a distinct alarm event when a published EC2 range cannot be covered (no room)', async () => {
        const error = vi.fn();
        ec2 = fakeEc2(inSync());
        await runSync({ getIpRanges: async () => awsJson(MIN_EC2_RANGES + 3), ec2, now: NOW, config: config({ maxRules: MIN_EC2_RANGES }), log: { info: () => {}, error } });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('ip_sync_uncovered_ec2'));
    });
});

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — loadConfig() / handler()', () => {
    it('requires a security group id', () => {
        expect(() => loadConfig({})).toThrow(/SECURITY_GROUP_ID/);
    });

    it('defaults to DRY RUN unless DRY_RUN is explicitly "false"', () => {
        expect(loadConfig({ SECURITY_GROUP_ID: SG }).dryRun).toBe(true);
        expect(loadConfig({ SECURITY_GROUP_ID: SG, DRY_RUN: 'true' }).dryRun).toBe(true);
        expect(loadConfig({ SECURITY_GROUP_ID: SG, DRY_RUN: 'false' }).dryRun).toBe(false);
    });

    it('reads limits from the environment, with the documented defaults', () => {
        expect(loadConfig({ SECURITY_GROUP_ID: SG })).toMatchObject({ maxRules: 60, reserveSlots: 2, graceDays: 14, dbPort: 5432 });
        expect(loadConfig({ SECURITY_GROUP_ID: SG, MAX_RULES: '200', RESERVE_SLOTS: '5', GRACE_DAYS: '30' })).toMatchObject({ maxRules: 200, reserveSlots: 5, graceDays: 30 });
    });

    it('handler() ignores the SNS payload (never trusts a URL or data from the message) and still runs a full sync', async () => {
        const ec2 = fakeEc2(inSync());
        const getIpRanges = vi.fn().mockResolvedValue(awsJson());
        const snsEvent = { Records: [{ Sns: { Message: JSON.stringify({ url: 'https://evil.example/ip-ranges.json' }) } }] };
        await handler(snsEvent, {}, { ec2, getIpRanges, now: NOW, config: config({ maxRules: MIN_EC2_RANGES }), log: silent });
        expect(getIpRanges).toHaveBeenCalledWith(); // no URL argument taken from the event
    });
});

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — ec2 adapter', () => {
    function fakeSdk(send) {
        class Cmd { constructor(input) { this.input = input; } }
        const mk = (name) => class extends Cmd { constructor(i) { super(i); this.name = name; } };
        return {
            EC2Client: class { constructor(opts) { this.opts = opts; } send(c) { return send(c); } },
            DescribeSecurityGroupRulesCommand: mk('describe'),
            AuthorizeSecurityGroupIngressCommand: mk('authorize'),
            RevokeSecurityGroupIngressCommand: mk('revoke'),
            ModifySecurityGroupRulesCommand: mk('modify'),
        };
    }

    it('describeInboundRules returns every inbound rule (paginated), including SG-reference rules', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce({ SecurityGroupRules: [
                { SecurityGroupRuleId: 'a', IsEgress: false, CidrIpv4: '1.2.3.0/24', Description: 'AWS ap-south-1' },
                { SecurityGroupRuleId: 'e', IsEgress: true, CidrIpv4: '0.0.0.0/0' },
            ], NextToken: 'n1' })
            .mockResolvedValueOnce({ SecurityGroupRules: [
                { SecurityGroupRuleId: 'b', IsEgress: false, ReferencedGroupInfo: { GroupId: 'sg-x' }, Description: 'ref' },
            ] });
        const a = createEc2Adapter({ region: 'ap-south-1', sdk: fakeSdk(send) });
        const rules = await a.describeInboundRules(SG);
        expect(rules).toEqual([
            { ruleId: 'a', cidr: '1.2.3.0/24', description: 'AWS ap-south-1' },
            { ruleId: 'b', cidr: null, description: 'ref' },
        ]);
        expect(send.mock.calls[0][0].input.Filters).toEqual([{ Name: 'group-id', Values: [SG] }]);
        expect(send.mock.calls[1][0].input.NextToken).toBe('n1');
    });

    it('authorize / revoke / setDescription build the right TCP-port requests', async () => {
        const send = vi.fn().mockResolvedValue({});
        const a = createEc2Adapter({ region: 'ap-south-1', sdk: fakeSdk(send) });
        await a.authorize(SG, ['1.2.3.0/24'], 5432, 'aws-ip-sync EC2');
        await a.revoke(SG, ['sgr-1']);
        await a.setDescription(SG, { ruleId: 'sgr-2', cidr: '5.6.7.0/24', description: 'x' }, 5432);
        const [auth, rev, mod] = send.mock.calls.map(([c]) => c);
        expect(auth.input).toEqual({ GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '1.2.3.0/24', Description: 'aws-ip-sync EC2' }] }] });
        expect(rev.input).toEqual({ GroupId: SG, SecurityGroupRuleIds: ['sgr-1'] });
        expect(mod.input).toEqual({ GroupId: SG, SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-2', SecurityGroupRule: { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, CidrIpv4: '5.6.7.0/24', Description: 'x' } }] });
    });

    it('targets the region the security group lives in (not the Lambda\'s own region)', () => {
        let created;
        const sdk = fakeSdk(vi.fn());
        const Orig = sdk.EC2Client;
        sdk.EC2Client = class extends Orig { constructor(o) { super(o); created = o; } };
        createEc2Adapter({ region: 'ap-south-1', sdk });
        expect(created.region).toBe('ap-south-1');
    });
});
