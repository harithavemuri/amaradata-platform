---
name: feedback-multiselect-all-none-invert
description: Every multi-select UI control must offer Select All, Select None, and Invert convenience actions
metadata:
  type: feedback
---

Wherever a UI presents a multi-select (a `<select multiple>`, a checkbox list, or similar), always add three convenience actions: **Select All**, **Select None**, and **Invert** (toggle each option's selected state).

**Why:** Standing instruction from the user (2026-09-05), stated as a permanent rule to apply across every project, not just where first raised — a `rohas-group` multi-select property/project picker had shipped with only All/None, missing Invert.

**How to apply:** Any time a new multi-select control is added, or an existing single-select is converted to multi-select, include all three actions as small, clearly labeled affordances near the control (buttons or text links). Standing rule for all future UI work in this project, not scoped to one page or feature.
