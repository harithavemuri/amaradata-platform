---
name: feedback-case-insensitive-search
description: "All DB queries and NonDB filter comparisons must be case-insensitive except password checks"
metadata:
  type: feedback
---

## Rule: Case-insensitive searches everywhere except passwords

**User explicitly asked to permanently remember this.**

All text-field lookups — username, email, name, slug, ref_number, etc. — must be case-insensitive in both DB mode and NonDB mode. The only exception is password comparisons (bcrypt compares hashes, not plain text — never apply case folding there).

### DB mode (PostgreSQL)

Use `lower(column) = lower($N)` — never bare `=` for user-supplied text:

```sql
-- correct
WHERE lower(username) = lower($1)
WHERE lower(email)    = lower($1)
WHERE lower(name)     = lower($1)

-- also acceptable (PostgreSQL extension)
WHERE column ILIKE $1

-- wrong
WHERE username = $1
WHERE email    = $1
```

### NonDB mode (FileDbService `.filter()`)

Fold both sides to lowercase before comparing:

```js
// correct
const uLower = username.toLowerCase();
.filter(u => u.username?.toLowerCase() === uLower)

// wrong
.filter(u => u.username === username)
```

**Why:** User mandated — searching "Haritha" vs "haritha" vs "HARITHA" must all find the same record.

**How to apply:** Whenever I write or review a query that filters on a text column (that isn't a password hash or an internal enum stored in a known case), apply case folding on both sides. If in doubt, apply it — the cost is negligible and the correctness gain is real.

[[feedback-db-queries-backend-only]]
