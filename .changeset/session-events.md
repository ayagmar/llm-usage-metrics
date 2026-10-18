---
'@ayagmar/agent-sessions': minor
---

Add `readEvents`, which reads a file as `SessionEvent`s: `usage` (`UsageRecord`), `message`
(`MessageEvent`), `tool_call` (`ToolCallEvent`) and `session_meta` (`SessionMetaEvent`).
`ReadEventsOptions.kinds` picks the kinds to yield; message text and session titles are
left out unless `text: true`, and `raw: true` attaches the parsed record.

- `SourceCapabilities.kinds` lists the kinds an adapter can yield; unset means `['usage']`.
  claude, codex and pi yield all four.
- A `UsageRecord` carries `messageId`, `requestId` and `rawProvider` when the source logs
  them.
- Also exported: `EVENT_KINDS`, `isUsageRecord`, the `kinds(...)` stream stage, and
  `createUsageRecord`, `createMessageEvent`, `createToolCallEvent` and
  `createSessionMetaEvent`.
