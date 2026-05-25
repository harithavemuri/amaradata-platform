---
name: feedback-nondb-no-aws
description: "NonDB mode must have zero AWS RDS or DynamoDB dependencies — no database AWS services — for both amaradata and rohas-group. Other AWS services (SES, S3 for assets, etc.) are allowed."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c7bd7a7f-1b10-49eb-a541-c6cf2dc5f239
---

NonDB mode must have **zero AWS RDS or DynamoDB dependencies** for both amaradata-platform and rohas-group.

**Why:** NonDB mode is the local/offline/dev mode. Using AWS database services (RDS, Aurora, DynamoDB) defeats the purpose of the file-based fallback and breaks the ability to run either site without a database. Other AWS services (SES for email, S3 for file storage, SSM for config) are permitted in NonDB mode if they serve non-database purposes.

**How to apply:**
- Any feature that needs persistence in NonDB mode must use JSON files in `transactiondata/` only.
- Never add RDS/Aurora connection calls or DynamoDB SDK calls inside a `req.db.mode === 'nondb'` branch.
- SES, S3, SSM, and other non-database AWS services are fine in NonDB mode.
- This rule covers: user records, tokens, session state, transactional data — everything must go to/from JSON files in NonDB mode.
- Applies to both sites: [[rohas-group-constraints]] and amaradata.
