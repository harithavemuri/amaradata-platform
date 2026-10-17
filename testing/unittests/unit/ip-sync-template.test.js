// @vitest-environment node
/**
 * ip-sync/template.yaml — structural guards on the security-sensitive parts of
 * the sync Lambda's deployment (raw-text checks; CloudFormation intrinsics
 * aren't plain YAML). The function can rewrite the shared Aurora security
 * group, so what it is allowed to do, and what it does by default, is pinned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T = fs.readFileSync(path.resolve(__dirname, '../../../ip-sync/template.yaml'), 'utf8').replace(/\r\n/g, '\n');

describe('@application:platform @boundedcontext:infrastructure @feature:ip-sync — template', () => {
    it('defaults to DRY RUN (nothing changes until DryRun is explicitly set to false)', () => {
        expect(T).toMatch(/DryRun:\n\s+Type: String\n\s+Default: 'true'/);
    });

    it('is triggered by the AWS IP-range SNS topic and by a daily schedule', () => {
        expect(T).toMatch(/Type: SNS/);
        expect(T).toMatch(/Topic: !Ref SnsTopicArn/);
        expect(T).toMatch(/Type: Schedule/);
        expect(T).toMatch(/Schedule: cron\(/);
    });

    // IAM authorizes these calls against BOTH the group's ARN and the individual rule's ARN
    // (security-group-rule/sgr-...). The first live run failed with AccessDenied on the rule ARN
    // when only the group ARN was allowed — the doubles in ip-sync-handler.test.js can't see that.
    // The group ARN stays pinned to the one managed group; only the rule ARN is a wildcard, because
    // rule ids are not known at deploy time.
    it('write access: pinned to the one managed security group, plus the rule ARNs IAM also checks', () => {
        const write = T.match(/Action:\n(?:\s+- ec2:[A-Za-z]+\n)+\s+Resource:\n((?:\s+- .+\n)+)/);
        expect(write, 'write statement (resource list) not found').not.toBeNull();
        const resources = write[1].split('\n').map((l) => l.replace(/^\s+- /, '').trim()).filter(Boolean);
        expect(resources.some((r) => /security-group\/\$\{SecurityGroupId\}/.test(r))).toBe(true);
        expect(resources.some((r) => /security-group-rule\/\*/.test(r))).toBe(true);
        // the only wildcard allowed is the rule ARN
        expect(resources.filter((r) => r.includes('*') && !/security-group-rule\/\*/.test(r))).toEqual([]);
        expect(resources.filter((r) => /security-group\//.test(r) && !r.includes('${SecurityGroupId}'))).toEqual([]);
    });

    it('write actions are limited to authorize / revoke / modify rules', () => {
        const actions = [...T.matchAll(/- (ec2:[A-Za-z]+)/g)].map((m) => m[1]);
        expect(new Set(actions)).toEqual(new Set([
            'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress', 'ec2:ModifySecurityGroupRules',
        ]));
        expect(T).toMatch(/Action: ec2:DescribeSecurityGroupRules\n\s+Resource: '\*'/);   // read-only, not scopable
        expect(T).not.toMatch(/ec2:\*/);
    });

    it('failed runs are kept (dead-letter queue) and alarmed, and cost-allocation tags are set', () => {
        expect(T).toMatch(/OnFailure:/);
        expect(T).toMatch(/AWS::CloudWatch::Alarm/);
        expect(T).toMatch(/ip_sync_uncovered_ec2/);
        for (const tag of ['tenant:', 'application:', 'project:', 'component:']) expect(T).toContain(tag);
    });
});
