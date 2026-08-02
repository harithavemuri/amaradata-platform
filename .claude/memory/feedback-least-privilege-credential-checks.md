---
name: feedback-least-privilege-credential-checks
description: Never retrieve/display root or write-level credentials during investigation — use the lowest-privilege credential that can prove the point, and never print secret values when only checking config (host/port) would do.
metadata:
  type: feedback
---

Never retrieve or display root/write-level (high-privilege) credentials while investigating something — use the least-privileged credential available that can actually prove the point.

**Why:** While investigating a possible read/write-pool replica-lag theory for a 401 login bug, printed the Lambda's full DB environment block including `AMRD_DB_WRITE_PASSWORD` and `AMRD_DB_READ_PASSWORD` in plaintext — but the actual question ("do the read and write pools point to different hosts?") only needed the `AMRD_DB_HOST` value, never the passwords at all. User's correction: "Don't retrieve root password. If you doubted the network connection then you should have tested with read user and then if that worked that rules out network connection right?" — i.e. (1) don't pull high-privilege secrets when a lower-privilege one (or no secret at all) answers the question, and (2) when the actual goal is ruling out connectivity/network issues, a successful connection with the *read* user already proves the network path works — there's no reason to ever reach for the write/root credential for that purpose.

**How to apply:** Before querying a secrets manager, SSM, or a Lambda's environment for credentials: ask what specific value the current question actually needs. If it's "does this config point where I expect" (host, port, region), fetch only the non-sensitive fields — never print full credential blocks wholesale. If it's "is there a real connectivity/network problem," test with the least-privileged credential that exists (read-only, staff-tier, etc.) — success there already rules out network-level failure without ever touching write/root/admin secrets. Only retrieve a specific credential's actual value when the value itself (not just "does auth succeed") is what's being debugged. Applies to both amaradata-platform and rohas-group, and to any secret source (AWS Secrets Manager, SSM, Lambda env vars, .env files).
