---
'@ayagmar/agent-sessions': minor
---

Add `SourceCapabilities.usagePerRequest`: the adapter's usage events each record a single
model request, so prices that depend on one request's prompt size can apply per event.
claude, gemini, pi, opencode and antigravity set it.
