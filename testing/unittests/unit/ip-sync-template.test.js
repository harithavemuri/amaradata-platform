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

    it('can only modify rules on the one managed security group (no wildcard write resource)', () => {
        const write = T.match(/Action:\n(\s+- ec2:[A-Za-z]+\n)+\s+Resource: (.+)\n/);
        expect(write, 'write statement not found').not.toBeNull();
        expect(write[2]).toMatch(/security-group\/\$\{SecurityGroupId\}/);
        expect(write[2]).not.toMatch(/\*/);
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
