---
name: feedback-precommit-hook-noop
description: Pre-commit hooks must never run the test suite or any slow/blocking work — always a no-op; testing is gated exclusively at deploy time
metadata:
  type: feedback
---

Every repo's `pre-commit` git hook must be a no-op (`exit 0`) — never run the test suite, linting, or any other slow/blocking work. Testing is gated exclusively at deploy time via `npm run deploy` (its first phases run the full test suite before anything touches AWS) — that remains the one authoritative check.

**Why:** User directive. Running the full test suite in `pre-commit` made every commit take 3-5+ minutes and fail intermittently on tests unrelated to what was actually being committed. First fixed in `rohas-group` (its `scripts/pre-commit.template` has been a no-op for a while). `amaradata-platform`'s equivalent hook was never migrated — `.git/hooks/` isn't version-controlled, and this repo had no tracked setup script to catch the drift, so it silently kept running the full chain. Found only when Claude's own commit hit a tool timeout mid test-run (2026-09-05), and dirtied test-fixture files as a side effect of the interrupted run.

**How to apply:** A repo's `pre-commit` hook must be installed from a git-tracked `scripts/pre-commit.template` (+ `scripts/setup-git-hooks.sh`/`.bat` to install it), not left as an untracked, ad hoc `.git/hooks/pre-commit` — otherwise this exact drift recurs silently. Any per-commit best-effort housekeeping (e.g. this repo's `sync-tenant-fixes` job) belongs in `post-commit`, not `pre-commit`, so it never blocks/delays committing. **Before assuming any repo's hooks already comply, read `.git/hooks/pre-commit`'s actual content directly** — this memory alone won't catch drift, since git hooks aren't tracked and a fix in one repo doesn't propagate to siblings.
