---
name: feedback-release-tagging
description: Always create and push an annotated git tag for the release before deploying to production
metadata:
  type: feedback
---

Before running a production deploy, always create an annotated git tag (`git tag -a vX.Y.Z -m "..."`) summarizing what's in the release, and push it (`git push origin vX.Y.Z`) — then proceed with the deploy.

**Why:** User asked for this to be a permanent step for rohas-group and confirmed it should carry over to amaradata-platform too.

**How to apply:**
- Version number: match `version` in `package.json` unless the user specifies otherwise.
- Tag message: a short bullet summary of what changed in the release (mirrors the commit message, doesn't need to duplicate it verbatim).
- Order: tag and push the tag *first*, then run the deploy (`git tag` → `git push origin <tag>` → `npm run deploy`) — don't deploy first and tag after.
- This applies to production deploys specifically; not established whether staging deploys need their own tag convention — ask if that comes up.
- Complements [[feedback-deploy-process]] (always `npm run deploy`, never raw `sam deploy`) and [[feedback-no-auto-deploy]] (never deploy without being explicitly asked) — tagging is an additional step within that same explicitly-authorized deploy flow, not a trigger to deploy on its own.
