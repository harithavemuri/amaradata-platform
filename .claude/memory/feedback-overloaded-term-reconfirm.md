---
name: feedback-overloaded-term-reconfirm
description: When the user uses a term that already names a shipped feature to describe new requirements, don't assume they mean the old definition — ask
metadata:
  type: feedback
---

If the user reuses a term that already has a specific, shipped meaning in the codebase (e.g. a status value, a flag, a table name) to describe a *new* requirement, and the new description doesn't clearly match that shipped meaning, stop and ask which one they mean.

**Why:** In rohas-group, the user described new `unavailable`-status requirements using the word "hidden" — a term that already named a shipped, tested feature (`properties.is_hidden`) with different, weaker semantics. Guessing wrong in either direction would have been costly: silently redefining the existing shipped behavior is a large, disruptive, unrequested scope change; silently leaving it alone if the user did mean it would miss a real gap they flagged. Asking directly, with the concrete behavioral consequence of each option spelled out, let the user make an informed choice instead of a guessed one.

**How to apply:** When a request's phrasing overlaps with an existing feature/field/table name in amaradata-platform (e.g. `is_billable`, `item_type`, `source='csv'`, `status` enums) but describes behavior that doesn't cleanly match what's already shipped, use `AskUserQuestion` to confirm which meaning is intended before writing code or migrating data — don't default to either the older or newer reading.
