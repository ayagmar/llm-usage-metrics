# @ayagmar/agent-sessions

Parsers for the session logs that local coding agents (Claude Code, Codex, Gemini CLI, OpenCode and others) write to disk. Each source turns its agent's files into one normalized usage event shape, so tools can count tokens, sessions and active time across agents without knowing each log format. It is the parsing layer of [llm-usage-metrics](https://github.com/ayagmar/llm-usage-metrics), split out so other tools can use it.

The package is read-only: it makes no network calls, never writes to the agents' stores, and reads nothing (environment, home directory, files) at import.

This package is still being extracted from the CLI and has no stable API yet.

## Contents

- `@ayagmar/agent-sessions`: the usage event model and its normalization, the `SourceAdapter` contract, `SourceContext`, the parse fingerprint, and the dedup stages (`dedupeRepeatedAcrossFiles`, `dedupeCopiedSessions`, `computeEventContentHash`).
- `@ayagmar/agent-sessions/registry`: every source registered in a fixed order, with `createDefaultAdapters`, `getDefaultSourceIds` and per-source storage format and worker support.
- `@ayagmar/agent-sessions/sources/<id>`: one adapter per entry (`pi`, `codex`, `gemini`, `droid`, `opencode`, `openclaw`, `claude`, `copilot`, `goose`, `amp`, `qwen`, `kimi`, `cline`, `roocode`, `kilocode`, `antigravity`, `dsh`). Importing one entry loads no other source's code, except that `roocode` and `kilocode` load `cline`, whose family adapter builds them.
- `@ayagmar/agent-sessions/internal`: helpers the CLI still uses (parsing and discovery utilities, the SQLite loader, fingerprint and hash-count helpers). Not a public API.
