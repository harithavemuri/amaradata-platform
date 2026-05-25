---
name: feedback-aws-infra-standards
description: "AWS infrastructure standards: cost-allocation tags on all resources, one consolidated log group per application — applies to both amaradata and rohas-group"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c7bd7a7f-1b10-49eb-a541-c6cf2dc5f239
---

## Rule: Always apply cost-allocation tags to every AWS resource

Every SAM/CloudFormation resource must carry these four tags:

| Tag key     | Value                          |
|-------------|-------------------------------|
| `tenant`    | `!Ref Tenant` (e.g. amaradata, rohas) |
| `application` | `!Ref TagApplication` (e.g. tenant-billing, property-management) |
| `project`   | `!Ref TagProject` (e.g. amaradata, amaracasa) |
| `component` | `shared` (or a specific component name) |

Drive `TagApplication` and `TagProject` from CloudFormation Parameters so they can be overridden per-stack without touching the template.

**Why:** User needs AWS Cost Explorer to break down billing by tenant, application, and project. Untagged resources are invisible in cost reports.

**How to apply:**
- Add `TagApplication` and `TagProject` to `Parameters` in every `template.yaml`
- Add `Tags:` block to `Globals/Function` (map format)
- Add `Tags:` list to every non-Lambda resource: S3, CloudFront, SG, DBSubnetGroup, DBCluster, LogGroup
- Lambda Functions inherit from Globals; individual Functions can override
- Resources that don't support tags (OAC, BucketPolicy, CustomResource) — skip silently

---

## Rule: One consolidated log group per application (not one per function)

Use a single `AWS::Logs::LogGroup` named `${Tenant}-${Env}` per stack.

```yaml
AppLogGroup:
  Type: AWS::Logs::LogGroup
  Properties:
    LogGroupName: !Sub '${Tenant}-${Env}'
    RetentionInDays: 7
    Tags: [...]
```

**Why:** User prefers one consolidated log group so all Lambda logs for an application land in one place for easy searching, rather than scattered across per-function log groups.

**How to apply:**
- Both amaradata and rohas-group stacks should have exactly one `AppLogGroup` resource
- RetentionInDays: 7 (project default)
- Tag it with the same four tags as all other resources

[[feedback-aws-infra-standards]]
