---
name: feedback-aws-infra-standards
description: "AWS infrastructure standards: cost-allocation tags on all resources, one consolidated log group with Lambda directed to it, 7-day retention nonprod / 30-day retention prod — applies to both amaradata and rohas-group"
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

## Rule: One consolidated log group per application — Lambda must write TO it

Use a single `AWS::Logs::LogGroup` named `${Tenant}-${Env}` per stack AND direct all Lambda functions to write to it via `LoggingConfig.LogGroup`.

```yaml
Conditions:
  IsProd: !Equals [!Ref Env, 'prod']

Globals:
  Function:
    LoggingConfig:
      LogFormat: JSON
      LogGroup: !Sub '${Tenant}-${Env}'   # <-- directs Lambda to the consolidated group

AppLogGroup:
  Type: AWS::Logs::LogGroup
  Properties:
    LogGroupName: !Sub '${Tenant}-${Env}'
    RetentionInDays: !If [IsProd, 30, 7]
    Tags: [...]

ApiFn:
  Type: AWS::Serverless::Function
  DependsOn: AppLogGroup   # <-- ensures group exists before Lambda is created
  ...
```

**Why:** Without `LogGroup` in `LoggingConfig`, Lambda auto-creates `/aws/lambda/<function-name>` groups that have no tags and no retention. Setting `LogGroup` in Globals redirects ALL Lambdas to the consolidated group.

**How to apply:**
- `Globals/Function/LoggingConfig`: add `LogGroup: !Sub '${Tenant}-${Env}'`
- Every `AWS::Serverless::Function` resource: add `DependsOn: AppLogGroup` (or list form if already depending on other resources)
- `RetentionInDays: !If [IsProd, 30, 7]` on the AppLogGroup — never hardcode
- Tag AppLogGroup with the same four tags as all other resources
