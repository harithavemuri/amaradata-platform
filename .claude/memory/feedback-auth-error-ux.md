---
name: feedback-auth-error-ux
description: On 401/403 — show access-denied popup with 10-second countdown, then redirect to login. Apply to both rohas-group and amaradata-platform.
metadata:
  type: feedback
---

When a user navigates to a page they don't have permission to access (401 or 403 from any API/GraphQL call), show a modal popup explaining they don't have access, with a 10-second countdown, then redirect to login.

**Why:** User asked for this explicitly — applies to both sites. Previously payment-tracker was silently redirecting; user wants visible feedback before redirect.

**How to apply:**
- In rohas-group: hook into `window.__onAuthError` in `sidebar.js` (already supports this hook). Show countdown modal, then redirect.
- In amaradata-platform: hook into the equivalent 401 interceptor in `platform.js`.
- The modal should show: "You don't have access to this page. Redirecting to login in N seconds…" with a Cancel/Stay button that clears the timer.
- Do NOT use `__onAuthError` to suppress the redirect permanently — only delay it with the countdown.
- Both sites must use the same pattern for consistency.
