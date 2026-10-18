---
'@ayagmar/agent-sessions': minor
---

`toolCallAttributes` (experimental, `./otel`) sets `error.type` = `_OTHER` on a failed call,
`llm_usage.tool.status` = `unknown` on a call without a recognised result, and
`llm_usage.message_id` when the call names its assistant message.
