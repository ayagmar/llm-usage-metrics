---
'@ayagmar/agent-sessions': minor
---

Goose and Antigravity reads retry a busy or locked database, as OpenCode reads already do.

Added:

- `maxBusyRetries` and `busyRetryDelayMs` on `GooseSourceAdapterOptions` and
  `AntigravitySourceAdapterOptions`, with OpenCode's defaults (2 retries, 50 ms linear
  backoff). A read retries only the work before its first event, so no event is yielded twice.

Changed:

- Goose and Antigravity read errors now name the database: "Could not read Goose DB at …",
  "Goose DB is busy/locked: …", and the same for Antigravity. OpenCode messages are unchanged.
- `./internal`: `toOpenCodeDbReadError` is now `toSqliteDbReadError`, which takes the source
  name, and `runWithBusyRetries` takes a `source` option.
