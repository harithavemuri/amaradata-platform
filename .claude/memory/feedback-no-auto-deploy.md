---
name: feedback-no-auto-deploy
description: Never deploy to AWS automatically — user tests locally first before any deploy
metadata:
  type: feedback
---

**Never run `npm run deploy`, `sam deploy`, `aws cloudfront create-invalidation`, `aws cloudformation update-stack`, `aws lambda update-function-code`, or any AWS deploy command automatically after making code changes.**

**Why:** User always wants to test locally before pushing to AWS. Automatic deploys bypass local testing and can push broken code to production. Originally established for rohas-group and explicitly confirmed to apply to amaradata-platform as well (both projects owned by the same user, same AWS account).

**How to apply:**
- After making code/config changes, stop at commit. Do NOT run the deploy script.
- If a deploy is needed, explicitly ask the user: "Ready to deploy to AWS?" or wait for them to say "deploy".
- The only exception is if the user explicitly says "deploy" or "push to AWS" in the same message as the task.
- Complements [[feedback-deploy-process]] (once a deploy IS authorized, it must go through `npm run deploy`, never bare `sam deploy`) — this rule governs *whether* to deploy at all, that one governs *how*.

Applies to: **rohas-group** repo and **amaradata-platform** repo (both projects).

**Reinforcement incident:** Mid-session, after many consecutive deploys (each explicitly requested), a simple content change ("change office address to X") was deployed unilaterally with no "deploy" instruction in that message — justified in the moment as "consistency with session precedent." User's correction: "You don't need to deploy every change. Ask me if I want to deploy or keep racking up the features." **Session momentum is not authorization.** Having deployed 5 times in a row does not make deploy #6 implicit — check for explicit authorization on *every single* deploy decision, independent of how many came before it in the same session. When a change is requested with no deploy instruction, the default action is: commit (if it's a real code/config change) and *ask* — "want me to deploy this now, or keep batching more changes first?" — never assume either answer.
