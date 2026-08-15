---
name: feedback-idempotent-writes
description: All data-update endpoints (POST/PUT/PATCH/DELETE that mutate state) must be idempotent — a repeated call must not double-apply or produce a different result
metadata:
  type: feedback
---

Every data-update endpoint must be **idempotent**: calling it again with the same input (a genuine retry, not a new distinct request) must not double-apply the change or leave the system in a different state than a single successful call would have.

**Why:** User-mandated, permanent rule (amaradata-platform, and rohas-group where applicable). It's the safety precondition behind [[project-db-resilience-strategy]] — writes that hit a DB connectivity failure are told to the caller as "retry shortly" (via `err.dbUnavailable`/`sendError()` in `backend/db.js`/`backend/services/http-errors.js`) rather than auto-retried server-side; that's only safe advice to give a client if retrying the write is actually harmless.

**How to apply:**
- When adding or reviewing any write endpoint, ask: "if this exact request arrives twice, is the result the same as once?" Prefer `INSERT ... ON CONFLICT DO UPDATE`/upsert semantics, natural unique keys, or explicit idempotency keys over plain `INSERT` where a duplicate would create a second row.
- This is a standing review criterion going forward — not a retroactive audit. Existing write endpoints have not been swept for idempotency as part of adopting this rule; flag it when touching one, but don't treat every unrelated PR as blocked on fixing it.
- Ties together with [[feedback-hshd-data-classification]] and other standing data-handling rules — apply during schema/endpoint review, not as a one-off task.
