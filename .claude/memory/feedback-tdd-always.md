---
name: feedback-tdd-always
description: Always follow TDD (test-first) — write the failing test before implementation code, for every change, not just bug fixes
metadata:
  type: feedback
---

Write the test before the implementation, every time — not just for bug fixes. `specs/constitution.md` already states "TDD: Red → Green → Refactor" as a rule; this makes it a standing instruction to actually follow, for all work: new features, refactors, and fixes alike.

**Why:** Explicit standing instruction from the user, given generally (not tied to one specific incident in amaradata-platform) — matches the identical rule already recorded in rohas-group's memory (`feedback_tdd_always.md`), so this is a cross-project practice, not amaradata-specific.

**How to apply:** Before writing implementation code for any new behavior, first write a test that exercises the intended behavior and confirm it fails for the right reason (red), then implement until it passes (green), then refactor if needed. Applies across all 5 test layers (see [[feedback-test-layers-db-first]]) — unit, API/integration, Playwright regression, release-tracking, and smoke/verification scripts alike. Place the test at the lowest layer that can exercise the behavior, matching whatever convention already exists for that kind of code, but the test-first ordering itself is not optional regardless of layer.

Applies to: **rohas-group** repo and **amaradata-platform** repo (both projects).
