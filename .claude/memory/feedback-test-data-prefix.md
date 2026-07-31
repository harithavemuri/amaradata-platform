---
name: feedback-test-data-prefix
description: Any test data created during production verification/testing must use identifiers starting with "zzzzzz"
metadata:
  type: feedback
---

Any record created in a **production** database for testing/verification purposes (smoke tests, release checks, ad-hoc debugging) must have its key identifier field — name, title, whatever the human-visible "this record is called X" field is — start with `zzzzzz`.

**Why:** If cleanup (afterEach/DELETE) ever fails to run or fails silently, stale test data left behind in production is otherwise indistinguishable from real tenant/user data. A `zzzzzz` prefix makes it immediately, visually obvious in any admin grid or DB query which rows are leftover test artifacts, and makes them trivially greppable/searchable to clean up later. Established in rohas-group, confirmed to apply to amaradata-platform too.

**How to apply:** whenever `scripts/smoke-prod.js` or any production verification check creates a record (a tenant, an enhancement, a contact submission, etc.) rather than only editing an existing one, prefix the human-readable identifier with `zzzzzz` (e.g. `zzzzzz smoketest tenant` instead of just `smoketest tenant`). Still delete/clean up the record afterward as normal — the prefix is a safety net for when that cleanup doesn't happen, not a replacement for it.
