---
'@ayagmar/agent-sessions': minor
---

`computeActiveMs` and `computeUnionActiveMs` now count a gap longer than `IDLE_GAP_CAP_MS` as 0 instead of as the cap, so an idle stretch adds no active time. A gap exactly at the cap still counts in full.
