# ip-sync — Aurora security-group IP allow-list sync

Keeps the shared Aurora cluster's security group (`sg-085d3a401508c7b5c`, `ap-south-1`) in step with AWS's
published `ap-south-1` IP ranges on port 5432. The Lambdas are non-VPC, so they reach Aurora from AWS-owned
IPs and the group allow-lists AWS's ranges; AWS changes the list and hand-maintained rules drift.

Design and rules: see "Aurora security-group IP sync" in the repo-root `CLAUDE.md`. In short:

- Only remove what AWS removed (after `GraceDays`, default 14).
- Add new ranges to fill the 60-rule quota (EC2 ranges first; `ReserveSlots` stay free).
- Never touch rules it doesn't own: only descriptions starting `AWS ap-south-1` or `aws-ip-sync` are managed.
  The home pgAdmin `/32`, undescribed `/32`s and SG-to-SG rules (e.g. `DBMigrateFn`'s) are left alone.

## Deploy the sync (production change — confirm first)

```bash
cd ip-sync
sam build
sam deploy --region us-east-1          # the AWS SNS topic lives in us-east-1
```

It starts in **dry run** (`DryRun=true`): it logs an `ip_sync_plan` event to CloudWatch log group
`/aws/lambda/amrd-ip-sync` and changes nothing. Review a few runs, then redeploy with
`--parameter-overrides DryRun=false`.

Before the first deploy, verify the `SnsTopicArn` default against AWS's IP-ranges documentation.

## One-time manual catch-up (2026-10-17)

The sync retires a range AWS removed only after a 14-day grace period, and the group was already at its
60-rule limit, so one EC2 range (`3.2.116.0/24`) could not be added meanwhile. On 2026-10-17 the owner chose to
apply the result immediately instead of waiting. These are the exact commands.

**1. Re-check first — the rule IDs below are only valid if the group still looks like this.** Run:

```bash
aws ec2 describe-security-group-rules --region ap-south-1 \
  --filters Name=group-id,Values=sg-085d3a401508c7b5c \
  --query 'SecurityGroupRules[?IsEgress==`false`].[SecurityGroupRuleId,CidrIpv4,Description]' --output table
```

Expect these three rules (described `AWS ap-south-1 (EC2)`, ranges AWS no longer publishes) and a total of 60
inbound rules. If they differ, stop and re-plan instead of running the commands below.

| Rule ID | CIDR |
|---|---|
| `sgr-0c138af7e2c2d03d6` | `64.73.215.0/24` |
| `sgr-06b4bec368c74c8e3` | `64.73.214.0/24` |
| `sgr-08665456689d46b62` | `64.73.216.0/24` |

**2. Revoke the three stale ranges first** (the group is at its limit, so this frees the slots):

```bash
aws ec2 revoke-security-group-ingress --region ap-south-1 --group-id sg-085d3a401508c7b5c \
  --security-group-rule-ids sgr-0c138af7e2c2d03d6 sgr-06b4bec368c74c8e3 sgr-08665456689d46b62
```

**3. Authorize the missing EC2 range**, described `aws-ip-sync EC2` so the sync adopts it later:

```bash
aws ec2 authorize-security-group-ingress --region ap-south-1 --group-id sg-085d3a401508c7b5c \
  --ip-permissions 'IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=3.2.116.0/24,Description="aws-ip-sync EC2"}]'
```

**4. Verify.** Re-run the command from step 1. Expect 58 inbound rules, `3.2.116.0/24` present, the three stale
ranges gone, and these still present: `96.231.55.86/32` (Home pgAdmin), `195.229.45.88/32` (no description) and
the SG-reference rule for `sg-017eec41207595d84` (`DBMigrateFn`).

Windows note: in Git Bash, run these with `MSYS_NO_PATHCONV=1` if an argument starting with `/` is rewritten; none of
the commands above need it as written.

## Tests

`testing/unittests/unit/ip-sync-lib.test.js`, `ip-sync-handler.test.js`, `ip-sync-template.test.js`:

```bash
npx vitest run --config testing/unittests/vitest.config.js testing/unittests/unit/ip-sync-*.test.js
```

## Status

Deployed 2026-10-17 as stack `amrd-ip-sync` (us-east-1), **in dry run** (`DryRun=true`). Verified against real AWS: the
stack creates, the subscription to AWS's `AmazonIpSpaceChanged` topic exists, and a manual invoke reads the live group
and AWS's list and logs the expected plan.

Turned on the same day (`DryRun=false`, `GraceDays=14`). The first live write failed with AccessDenied: IAM checks
`ModifySecurityGroupRules` / authorize / revoke against each rule's own ARN (`security-group-rule/sgr-...`) as well as
the group's, and the policy only allowed the group — fixed (the group ARN stays pinned; only the rule ARN is a wildcard).
After the fix all three write calls ran against the real group: the 3 ranges AWS no longer published were relabelled,
then revoked, `3.2.116.0/24` was added (group 60 -> 58 rules), a further run was a no-op, and a production smoketest login
on cloud and rohas passed afterwards. For that catch-up `GraceDays` was temporarily 0, then restored to 14.

The "uncovered EC2 range" alarm (`amrd-ip-sync-uncovered-ec2-range`) fires when the group has no room for a published
EC2 range; no alarm topic is configured (`AlarmTopicArn`), so nothing is notified until one is set.

After any refresh, check one production smoketest login on both cloud and rohas.
