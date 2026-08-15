---
name: feedback-hshd-data-classification
description: HSHD (Highly Sensitive Human Data — PAN, SSN, Passport Number, etc.) must be stored encrypted with tracked decrypt access; regular PII may be plaintext but access must still be tracked
metadata:
  type: feedback
---

**HSHD** = Highly Sensitive Human Data (examples: PAN, SSN, Passport Number, and similar government/financial identity numbers).

Data handling rule, by classification:
- **PII** (general personally identifiable info, not HSHD): may be stored plain text, but access must be tracked/logged.
- **HSHD**: must be stored **encrypted at rest**, and every access that **decrypts** it must be tracked/logged.

**Why:** User-defined, permanent data classification standard for this codebase (and sibling tenant repos like rohas-group) — HSHD carries materially higher sensitivity/regulatory risk than ordinary PII, so it gets a stricter bar (encryption, not just access logging).

**How to apply:** When adding or reviewing any schema, table, or field that stores personal data, first classify it as HSHD or plain PII.
- If HSHD: it must be encrypted before write (see amaradata-platform's existing `pii-encryption-key` secret in Secrets Manager — no rotation mechanism currently exists for it, per `CLAUDE.md`), and any code path that decrypts/reads the plaintext value must emit an access-tracking record (who, when, which record).
- If plain PII: encryption is not required, but reads/access still need to be tracked/logged — don't skip logging just because it's stored in plaintext.
- Applies across both amaradata-platform and rohas-group, since both handle tenant/user personal data.
- Flag any new field that looks like it could be HSHD (PAN, SSN, passport, national ID, etc.) during schema review even if the user doesn't explicitly call it out.
