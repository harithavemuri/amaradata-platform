---
name: feedback-no-raw-client-errors
description: Frontend must never show a raw JS/fetch exception message to the user either — generic message + console.error, mirroring the backend's own no-raw-errors rule
metadata:
  type: feedback
---

Extends [[feedback-no-db-errors-to-frontend]] to the client side: when a `catch` block in frontend JS displays `e.message` directly to the user, that's just as much a leak as the backend sending a raw stack trace — except here the leaked text is a *browser/JS-internal* message (`"Failed to execute 'json' on 'Response': Unexpected end of JSON input"`, `"Failed to fetch"`, etc.), not even a message the backend intended to show.

**Why:** Real occurrence in rohas-group (2026-07-19): a save handler doing `const j = await r.json();` with no guard let a malformed/empty response body throw a raw `SyntaxError` straight into the error banner's `textContent`. User's explicit rule: this should read "Sorry, unable to process your request at this time." with the real detail logged, not shown. Confirmed to apply to amaradata-platform too.

**How to apply:**
- Distinguish *expected* errors (a `throw new Error(j.message || j.error || ...)` built from a real, already-sanitized backend response — safe to display verbatim) from *unexpected* ones (JSON-parse failure, network failure, any exception not deliberately thrown with a user-meant message).
- For the unexpected case: `console.error` the real error (with enough context — url, status — to debug) and display a generic fallback instead.
- Any `fetch(...).then(r => r.json())` or `await r.json()` call in `frontend/js/platform.js` or any `frontend/*.html` inline script that lands in a user-facing error display should guard against a JSON-parse throw the same way.
