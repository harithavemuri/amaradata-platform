---
name: feedback-amaradata-repo-commits-only
description: Never run git commit/push in the rohas-group repo, even though it's an accessible working directory — only amaradata-platform gets committed to by this assistant.
metadata:
  type: feedback
---

Only ever run `git commit`/`git push` in the **amaradata-platform** repo. Never commit or push in **rohas-group**, even though its directory is accessible for reading/investigation.

**Why:** User's explicit correction: "You only commit Amaradata repo." Said after investigating a rohas-group CloudFront certificate issue (found via `git log` in that repo) and asking to "commit and push" — the user clarified the commit/push scope is restricted to amaradata-platform specifically, regardless of which repo a fix/investigation touches.

**How to apply:** Reading, grepping, and investigating rohas-group's code/git history is fine (needed for cross-repo work like the shared DB cluster or CloudFront cert issue). Editing rohas-group files when explicitly asked is presumably still fine (not yet tested/confirmed — ask if unsure). But `git commit`/`git push`/`git add` as a *repo-modifying action* must never run in rohas-group — the user commits changes there themselves. This is stricter than [[feedback-no-auto-deploy]] (which governs *whether/when* to deploy, applies to both repos) — this rule governs *which repo* gets committed to at all, full stop.
