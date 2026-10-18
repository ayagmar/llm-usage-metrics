---
'@ayagmar/agent-sessions': minor
---

Add `UsageEvent.singleRequest`: `true` when the event records exactly one model request, so
prices that depend on one request's prompt size can apply to it. claude, gemini, pi,
opencode and antigravity set it on every event; codex sets it on per-response usage records
and on `token_count` deltas equal to `last_token_usage`. The codex parser version is now 5.
