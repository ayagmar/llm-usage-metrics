# @ayagmar/agent-sessions

Parsers for the session logs that local coding agents (Claude Code, Codex, Gemini CLI, OpenCode and others) write to disk. Each source turns its agent's files into one normalized usage event shape, so tools can count tokens, sessions and active time across agents without knowing each log format. It is the parsing layer of [llm-usage-metrics](https://github.com/ayagmar/llm-usage-metrics), split out so other tools can use it.

The package is read-only: it makes no network calls, never writes to the agents' stores, and reads nothing (environment, home directory, files) at import.

This package is still being extracted from the CLI and has no stable API yet.
