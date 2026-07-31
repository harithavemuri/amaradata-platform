---
name: feedback-playwright-nested-describe-login
description: Never nest a test.describe that logs in as a different user inside one that already logs in — nested beforeEach hooks share the same page for one test, and login.html's already-logged-in redirect breaks the second login
metadata:
  type: feedback
---

If describe A's `beforeEach` logs in as user X, and describe B is nested *inside* A and its own `beforeEach` tries to log in as user Y, both hooks run against the **same `page`** for any test in B (Playwright runs outer hooks before inner ones for a single test, it doesn't give each describe level its own page). `login.html` auto-redirects to `/dashboard` whenever `window.__amrd.isLoggedIn()` is already true, so the second `page.goto('/login')` bounces away before `#username` ever renders — `page.fill('#username', ...)` then times out waiting for a locator that will never appear.

**Why:** Hit this for real building `edit-save-enhancements.spec.js`'s filter tests — nested them inside the file's main `describe` (which logs in as `admin`), with their own `beforeEach` logging in as `site_admin` for tenant-visibility reasons. All 3 filter tests timed out identically on `page.fill('#username', ...)` inside `loginAs()`. Fixed by making the filter tests a separate top-level `test.describe`, not nested.

**How to apply:** Whenever a new `describe` block within an existing spec file needs a *different* logged-in user than the file's outer `describe`, make it a sibling top-level `test.describe`, never nested. If it needs the *same* user as the outer describe, nesting is fine (no second `loginAs()` call needed — just reuse the already-authenticated page). This applies to any spec file, not just enhancements.
