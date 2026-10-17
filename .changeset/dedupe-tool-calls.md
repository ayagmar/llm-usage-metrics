---
'@ayagmar/agent-sessions': minor
---

Add `dedupeToolCalls` on `.`: it counts a tool call once when sessions of one source repeat
it under the same call id, keeping the first copy with the status of the first copy that
has a result. The CLI's `tools` report and `session --timeline` use it.
