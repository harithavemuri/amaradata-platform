---
name: feedback-date-format
description: All dates in the frontend must display as "Mon DD YYYY" (e.g. "May 01 2026") — never raw ISO strings, Unix timestamps, or numeric values
metadata:
  type: feedback
---

Always format dates as `month dd yyyy` using `toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })`.

**Why:** User explicitly mandated this format permanently. Raw ISO slices and Unix timestamps were appearing in the UI.

**How to apply:** Use this helper in every frontend HTML file that displays any date field:
```js
const fmtDate = d => {
    if (!d && d !== 0) return '—';
    // Handle Unix second timestamps (numbers or pure-digit strings)
    const asNum = typeof d === 'number' ? d : (/^\d{9,12}$/.test(String(d)) ? Number(d) : NaN);
    const date = isNaN(asNum) ? new Date(d) : new Date(asNum * 1000);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
};
```

Never use `.slice(0,10)` on a date field. Never display raw epoch integers.
