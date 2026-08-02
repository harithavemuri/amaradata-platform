---
name: feedback-verify-before-responding
description: Never answer a diagnostic/explanatory question with an assumed or inferred reason — verify concretely (screenshots, direct checks, logs, live queries) before responding.
metadata:
  type: feedback
---

Never state a conclusion to the user based on inference or a plausible-sounding explanation alone — verify it directly first, then respond.

**Why:** User called this out explicitly and emphatically ("DO NOT ASsume verify before you respond") after an incident where a favicon-mismatch question was first answered with "likely browser caching" reasoning, without concrete proof, before the user pushed back ("how come local is right but not prod") and prompted the deeper verification (a fresh, cache-free browser context screenshot of the live production favicon) that should have been done from the start. Even a well-reasoned, probably-correct inference is not sufficient — it must be independently verified before being presented as the answer. Related: [[feedback-verify-exit-codes]] (same root principle — never trust unverified state — but scoped narrowly to command exit codes; this memory is the general form).

**How to apply:** Before answering any "why is X happening," "is Y broken," "did Z work" type question — in either amaradata-platform or rohas-group, for infra, code behavior, deploy status, or anything else — gather direct evidence first: screenshots from a clean/fresh context, actual file diffs, live curl/API checks, log greps, CloudWatch queries, database reads, etc. Do not answer from general knowledge or "this is probably what's happening" reasoning alone, even when the explanation seems obvious or highly likely. Verify, then respond.
