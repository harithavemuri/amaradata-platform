---
name: feedback-db-queries-backend-only
description: DB queries must only run on the backend (server-side routes), never from frontend JavaScript
metadata:
  type: feedback
---

DB queries must **never** run directly from frontend code. All database access happens exclusively in backend route handlers (`backend/routes/*.js`), which run server-side in Express/Lambda.

**Why:** Security and architecture principle — the frontend (browser JS) must never have direct database access. It communicates only via the REST API (`/api/*`).

**How to apply:** Frontend HTML/JS calls `apiFetch('/api/...')` to talk to the backend. The backend route handler runs the DB query and returns JSON. Never put `db.query()` or any database client code in frontend files.
