---
name: feedback-no-db-errors-to-frontend
description: Raw DB/internal errors must never be sent to the frontend — log to CloudWatch, return generic 500 message
metadata:
  type: feedback
---

Backend route `catch` blocks must NEVER forward the raw error message to the frontend. Log it with `console.error` (which goes to CloudWatch in Lambda) and return a generic message.

**Why:** Raw DB errors leak schema details, table names, and query structure to the browser, which is a security and UX problem.

**How to apply:**
- Replace `res.status(500).json({ error: e.message })` with:
  ```js
  console.error('[route-name]', e.message);
  res.status(500).json({ error: 'Internal server error' });
  ```
- Specific 4xx responses (400 validation, 404 not found, 409 conflict) CAN and SHOULD still include a helpful message — the rule is for 5xx only.
- The global Express error handler in server.js must also never forward `err.message`.
