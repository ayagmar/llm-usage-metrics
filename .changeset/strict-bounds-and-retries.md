---
'@ayagmar/agent-sessions': minor
---

Reject bounds and options whose meaning depended on the host or was silently changed.

Breaking:

- `since()` and `until()` throw on a date-only string bound that is not an ISO date, such as
  `'2026/06/01'` or `'June 1, 2026'`. `Date.parse` reads those as local midnight, so the
  instant depended on the host time zone. Use `'2026-06-01'` (midnight UTC) or a date-time
  with `Z` or an offset.
- `OpenCodeSourceAdapter` throws when `maxBusyRetries` is not a non-negative integer, naming
  the source. A negative value used to be clamped to 0. Goose and Antigravity apply the same
  check.
