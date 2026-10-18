# @ayagmar/agent-sessions

## 0.1.0

First release. The parsers behind the `llm-usage-metrics` CLI, published on their own.

- Read-only adapters for 17 local coding-agent sources: Claude Code, Codex, pi, Gemini CLI,
  OpenCode, Antigravity, Goose, Amp, Qwen, Kimi, Cline, RooCode, KiloCode, Copilot, Droid,
  OpenClaw and DeepSeek Harness. Each turns its agent's files into one normalized event shape.
  No network calls, nothing read at import, no runtime dependencies.
- `readEvents` and `readSources` read `usage`, `message`, `tool_call` and `session_meta`
  events. Message text and session titles are left out unless `text: true`.
- Stream stages `kinds`, `since`, `until` and `bySession`. `since` and `until` reject
  date-only bounds that are not ISO dates.
- Usage events carry `singleRequest: true` when they record exactly one model request, so
  prices that depend on one request's prompt size can apply per event.
- Dedup steps for events repeated across files, copied sessions and repeated tool calls.
- A resumable JSONL read cursor, file fingerprints and parser versions, so a caller can
  cache parsed files and tell when they go stale.
- SQLite sources (OpenCode, Goose, Antigravity) retry a busy database before their first
  event.
- `./otel` (experimental): OpenTelemetry GenAI attributes for events, following
  `semantic-conventions-genai` commit `f49da22`. Paths and the git branch only with
  `includePaths: true`.

The public subpaths are `.`, `./registry` and `./sources/<id>`; `./otel` is experimental and
`./internal` has no stability promise. See the README for the versioning policy.
