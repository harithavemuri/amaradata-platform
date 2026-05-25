---
name: project-amaradata-domain
description: "Production URL for the amaradata platform is https://amaradata.com (apex domain, not platform.amaradata.com)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c1e1427-c1f7-485b-ab1f-578630994161
---

The amaradata platform's production URL is **https://amaradata.com** (apex domain).

**Why:** User confirmed this explicitly — not platform.amaradata.com or a *.cloudfront.net URL.

**How to apply:** All FrontendUrl defaults, CORS origins, SSM parameters, Google OAuth redirect URIs, and CloudFront alias configuration should use `https://amaradata.com`. The Google redirect URI for prod is `https://amaradata.com/api/auth/google/callback`.
