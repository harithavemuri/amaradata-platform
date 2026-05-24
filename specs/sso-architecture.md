# SSO Architecture — AmaraData Platform

## Overview

AmaraData acts as the **SSO issuer** for all tenant sites (Rohas Group, future tenants). A user who is already authenticated in AmaraData can be silently logged in to any tenant site by clicking a single link — no second login prompt.

## Flow

```
User (authenticated in AmaraData)
  │
  ├─► POST /api/auth/sso/issue  { aud: "rohas" }
  │       ← { sso_token: "<60-sec JWT>", login_url: "https://rohas.com/auth/sso?sso_token=..." }
  │
  └─► Browser navigates to login_url
          │
          └─► GET /auth/sso?sso_token=...   (Rohas Lambda: auth-sso.js)
                  ├─ Verify HMAC-SHA256 with shared SSO_SECRET
                  ├─ Check exp (must be < 60s old)
                  ├─ Check aud === "rohas"
                  └─ Sign Rohas JWT (1h) with Rohas JWT_SECRET
                  └─► 302 → /login.html?sso_jwt=<rohas-token>
                          │
                          └─► login.html JS (handleSsoRelay)
                                  stores token in localStorage
                                  → redirect to /admin/dashboard
```

## Token Format

### SSO Token (short-lived, 60 seconds)
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
{
  "iss": "amaradata",
  "aud": "rohas",           ← target tenant identifier
  "sub": "user@example.com",
  "name": "User Name",
  "role": "admin",
  "iat": 1234567890,
  "exp": 1234567950         ← iat + 60
}
```
Signed with `SSO_SECRET` (shared across all tenants, stored at `/shared/<env>/sso-secret` in AWS Secrets Manager).

### Rohas JWT (issued after SSO, 1 hour)
Standard HS256 JWT signed with Rohas's own `JWT_SECRET`, compatible with `backend/middleware/jwt-auth.js` verifier.

## Shared Secret

A single secret is shared between all participants:
- **Path**: `/shared/<env>/sso-secret` in AWS Secrets Manager
- **Created once**: `aws secretsmanager create-secret --name /shared/prod/sso-secret --secret-string "<64-char random>"`
- **Accessed by**: all Lambda functions that issue or consume SSO tokens

## Adding a New Tenant

1. Create tenant stack (e.g. `acme`)
2. Add `SSO_SECRET: '{{resolve:secretsmanager:/shared/${Env}/sso-secret}}'` to tenant's template.yaml
3. Implement the consumer: validate token, check `aud === "acme"`, issue tenant JWT
4. Add `/auth/sso` route to tenant's server.js
5. In AmaraData, call `POST /api/auth/sso/issue` with `{ aud: "acme" }` to get the login URL

## Security Properties

- SSO tokens expire in **60 seconds** — replay attacks are effectively prevented
- HMAC-SHA256 with a 64-char secret — unforgeable without the shared secret
- `aud` claim is verified — an acme token cannot be used to log into rohas
- `iss` claim is always `amaradata` — tenants cannot issue tokens for each other
- Rohas JWT (1h) has its own secret — compromise of SSO secret does not expose session tokens

## Authentication Methods

Both AmaraData and Rohas Group support two login methods:

| Method | AmaraData | Rohas Group |
|--------|-----------|-------------|
| Google OAuth (PKCE) | `POST /api/auth/google/login` | `POST /auth/login` |
| Email + password (bcrypt cost 12) | `POST /api/auth/login` | `POST /auth/email-login` |
| SSO (from AmaraData) | issuer only | `GET /auth/sso?sso_token=...` |

### Password Security

- Passwords are hashed with **bcrypt at cost factor 12**
- The plaintext password is never stored or logged
- Google-only accounts have an empty `password_hash`; attempting password login returns a clear error directing users to Google Sign-In
- The `POST /api/auth/create-user` endpoint (AmaraData) and direct DB insert (Rohas) are the only ways to set a password
