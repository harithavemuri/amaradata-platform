/**
 * Thin wrapper over the EC2 API for the one security group the sync manages.
 * Kept separate from handler.js so the orchestration can be tested without AWS.
 * The SDK (the Lambda nodejs22.x runtime bundles AWS SDK v3) is injectable.
 */
'use strict';

/**
 * @param {{ region: string, sdk?: any }} opts  region = where the security group lives (not necessarily where this Lambda runs)
 */
function createEc2Adapter({ region, sdk = require('@aws-sdk/client-ec2') }) {
    const client = new sdk.EC2Client({ region });
    const {
        DescribeSecurityGroupRulesCommand, AuthorizeSecurityGroupIngressCommand,
        RevokeSecurityGroupIngressCommand, ModifySecurityGroupRulesCommand,
    } = sdk;

    return {
        /** Every INBOUND rule on the group (CIDR and security-group-reference rules alike — both count toward the quota). */
        async describeInboundRules(groupId) {
            const rules = [];
            let NextToken;
            do {
                const out = await client.send(new DescribeSecurityGroupRulesCommand({
                    Filters: [{ Name: 'group-id', Values: [groupId] }],
                    NextToken,
                }));
                for (const r of out.SecurityGroupRules || []) {
                    if (r.IsEgress) continue;
                    rules.push({ ruleId: r.SecurityGroupRuleId, cidr: r.CidrIpv4 || null, description: r.Description || null });
                }
                NextToken = out.NextToken;
            } while (NextToken);
            return rules;
        },

        async authorize(groupId, cidrs, port, description) {
            await client.send(new AuthorizeSecurityGroupIngressCommand({
                GroupId: groupId,
                IpPermissions: [{
                    IpProtocol: 'tcp', FromPort: port, ToPort: port,
                    IpRanges: cidrs.map((CidrIp) => ({ CidrIp, Description: description })),
                }],
            }));
        },

        async revoke(groupId, ruleIds) {
            await client.send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, SecurityGroupRuleIds: ruleIds }));
        },

        async setDescription(groupId, { ruleId, cidr, description }, port) {
            await client.send(new ModifySecurityGroupRulesCommand({
                GroupId: groupId,
                SecurityGroupRules: [{
                    SecurityGroupRuleId: ruleId,
                    SecurityGroupRule: { IpProtocol: 'tcp', FromPort: port, ToPort: port, CidrIpv4: cidr, Description: description },
                }],
            }));
        },
    };
}

module.exports = { createEc2Adapter };
