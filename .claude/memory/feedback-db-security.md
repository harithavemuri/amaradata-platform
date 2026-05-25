---
name: feedback-db-security
description: "Security rules for RDS/Aurora, API Gateway, and Lambda — applies permanently to both amaradata-platform and rohas-group"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c7bd7a7f-1b10-49eb-a541-c6cf2dc5f239
---

## Rule: RDS/Aurora must NEVER be publicly accessible

The DB cluster (shared between amaradata and rohas-group) must never have `0.0.0.0/0` on port 5432.

**Why:** User security requirement. Public DB = critical vulnerability.

**Current setup (Option B — cost-free):**
- RDS SG `sg-085d3a401508c7b5c` allows inbound 5432 from:
  - `96.231.55.86/32` — home IP for pgAdmin access
  - 20 large AWS ap-south-1 CIDR blocks (covers Lambda outbound IPs, blocks all non-AWS internet)
- `PubliclyAccessible: false` set in template.yaml DBInstance
- Full VPC+NAT Gateway upgrade deferred (would cost ~$32/month)

**If home IP changes:** Revoke old CIDR, add new `/32` to `sg-085d3a401508c7b5c` on port 5432.

**How to apply:**
- Never add `0.0.0.0/0` to RDS/Aurora SGs in any future template or manual change
- `PubliclyAccessible: false` in all DBInstance SAM resources
- For local dev access to production DB: update SG with current home IP first

---

## Rule: CloudFront origin secret — block direct API Gateway hits

Both projects use a secret header (`x-origin-secret`) to block requests that bypass CloudFront and hit the API Gateway URL directly (cost + security protection).

**How it works:**
- CloudFront injects `x-origin-secret: <secret>` on all requests to the API origin
- Express middleware in `server.js` returns 403 if the header is missing/wrong
- Public routes (`/health`, `/api/site-config`, rohas `/`) are exempt

**Secrets (stored as Lambda env var `ORIGIN_SECRET`):**
- amaradata: `181defff50ccd4a3b321c7850a699ca3de763f96e76ca1a8c74445ce044e539c`
- rohas: `719964c035dc6637a1c7c58ccb9ba1a240825abe0a98fb4722c665e736e2395f`

**CloudFront distributions:**
- amaradata: `EVRE22H489D0P` (amaradata.com)
- rohas: `E1JH5G89DHDBXC` (d3u4zlri3r48dr.cloudfront.net)

---

## Rule: API Gateway throttling (both projects)

Both API Gateways throttled to **100 RPS steady / 200 burst** to limit Lambda cost from abuse.
- amaradata API: `aaenp052k9`
- rohas API: `8hou3irikk`

---

## Infrastructure: Shared Aurora cluster

- Both rohas-group and amaradata-platform share cluster `cim1jtcbsbbt`
- One SG change affects both — always update `sg-085d3a401508c7b5c`
- Master user: `amararoot`, secret at `/amaradata/aurora/master-password` in Secrets Manager

[[rohas-group-constraints]]
