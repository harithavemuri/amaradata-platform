---
name: project-smoketest-account-separation
description: smoketest.admin no longer shares the real harithavemuri@gmail.com email; a separate smoketest.siteadmin bootstrap account now exists for scripts/smoke-lifecycle.js's SMOKE_BOOTSTRAP_ADMIN_USER
metadata:
  type: project
---

`database/schema.sql`'s seed data used to give `smoketest.admin` the email `harithavemuri@gmail.com` — the real personal Google-linked account (`amr_users` id=1). Decoupled onto its own address, `smoketest.admin@amaradata.com`, so smoke tests can never touch the real account.

Separately, `scripts/smoke-lifecycle.js` needs a **permanent bootstrap `super_admin`** (`SMOKE_BOOTSTRAP_ADMIN_USER` in `.env.test`) to toggle `SMOKE_TEST_USER`'s (`smoketest.admin`'s) `is_active` flag around each smoke run — its own doc comment says this account "must never itself be the account that gets disabled." No such account was actually seeded anywhere before this. Added `smoketest.siteadmin` (`smoketest.siteadmin@amaradata.com`, role `super_admin`, same seed password `ez3Find@@123`) as a third, separate seeded account specifically for this purpose. `.env.test.example` updated to default `SMOKE_BOOTSTRAP_ADMIN_USER=smoketest.siteadmin`.

**Why:** User follow-up during [[project-super-admin-rename]]: "create smoketest.siteadmin and use that as siteadmin if needed" — closes a real gap (`project-testing-parity-increment2.md` had already flagged the bootstrap account as "not yet confirmed to exist").
