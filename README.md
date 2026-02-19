# llm-usage-metrics

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ayagmar/llm-usage-metrics)
[![CI](https://github.com/ayagmar/llm-usage-metrics/actions/workflows/ci.yml/badge.svg)](https://github.com/ayagmar/llm-usage-metrics/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/codecov/c/github/ayagmar/llm-usage-metrics)](https://codecov.io/gh/ayagmar/llm-usage-metrics)
[![npm version](https://img.shields.io/npm/v/llm-usage-metrics.svg)](https://www.npmjs.com/package/llm-usage-metrics)

CLI to aggregate local LLM usage from:

- `~/.pi/agent/sessions/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- OpenCode SQLite DB (auto-discovered or provided via `--opencode-db`)

Reports are available for daily, weekly (Monday-start), and monthly periods.

Project documentation is available in [`docs/`](./docs/README.md).

Built-in adapters currently support `.pi`, `.codex`, and OpenCode SQLite. The codebase is structured to add more sources (for example Claude/Gemini exports) through the `SourceAdapter` pattern. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Install

```bash
npm install -g llm-usage-metrics
```

Or run without global install:

```bash
npx --yes llm-usage-metrics daily
```

(`npx llm-usage daily` works when the project is already installed locally.)

Runtime notes:

- OpenCode parsing requires Node.js 24+ (`node:sqlite`).
- Bun is supported for dependency/scripts workflow, but OpenCode report runs should use Node-based CLI execution.
- Example local execution against built dist: `node dist/index.js daily --source opencode --opencode-db /path/to/opencode.db`

## Update checks

When installed globally, the CLI performs a lightweight npm update check on startup.

Behavior:

- uses a local cache (`<platform-cache-root>/llm-usage-metrics/update-check.json`; defaults to `~/.cache/llm-usage-metrics/update-check.json` on Linux when `XDG_CACHE_HOME` is unset) with a 1-hour default TTL
- optional session-scoped cache mode via `LLM_USAGE_UPDATE_CACHE_SCOPE=session`
- skips checks for `--help` / `--version` invocations
- skips checks when run through `npx`
- prompts for install + restart only in interactive TTY sessions
- prints a one-line notice in non-interactive sessions

To force-skip startup update checks:

```bash
LLM_USAGE_SKIP_UPDATE_CHECK=1 llm-usage daily
```

### Runtime environment overrides

You can tune runtime behavior with environment variables:

- `LLM_USAGE_SKIP_UPDATE_CHECK`: skip startup update check when set to `1`
- `LLM_USAGE_UPDATE_CACHE_SCOPE`: cache scope for update checks (`global` default, `session` to scope by terminal shell session)
- `LLM_USAGE_UPDATE_CACHE_SESSION_KEY`: optional custom session key when `LLM_USAGE_UPDATE_CACHE_SCOPE=session` (defaults to parent shell PID)
- `LLM_USAGE_UPDATE_CACHE_TTL_MS`: update-check cache TTL in milliseconds (clamped: `0..2592000000`; use `0` to check on every CLI run)
- `LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS`: update-check network timeout in milliseconds (clamped: `200..30000`)
- `LLM_USAGE_PRICING_CACHE_TTL_MS`: pricing cache TTL in milliseconds (clamped: `60000..2592000000`)
- `LLM_USAGE_PRICING_FETCH_TIMEOUT_MS`: pricing fetch timeout in milliseconds (clamped: `200..30000`)
- `LLM_USAGE_PARSE_MAX_PARALLEL`: max concurrent file parses per source adapter (clamped: `1..64`)

Example:

```bash
LLM_USAGE_PARSE_MAX_PARALLEL=16 LLM_USAGE_PRICING_FETCH_TIMEOUT_MS=8000 llm-usage monthly
```

## Usage

### Daily report (default terminal table)

```bash
llm-usage daily
```

### Weekly report with custom timezone

```bash
llm-usage weekly --timezone Europe/Paris
```

### Monthly report with date range

```bash
llm-usage monthly --since 2026-01-01 --until 2026-01-31
```

### Markdown output

```bash
llm-usage daily --markdown
```

### JSON output

```bash
llm-usage daily --json
```

### Offline pricing (use cached LiteLLM pricing only)

```bash
llm-usage monthly --pricing-offline
```

### Override pricing URL

```bash
llm-usage monthly --pricing-url https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
```

Pricing behavior notes:

- LiteLLM is the active pricing source.
- explicit `costUsd: 0` events are re-priced from LiteLLM when model pricing is available.
- when pricing cannot be loaded from LiteLLM (or cache in offline mode), report generation fails fast.

### Custom session directories

```bash
llm-usage daily --pi-dir /path/to/pi/sessions --codex-dir /path/to/codex/sessions
```

Or use generic source-id mapping (repeatable):

```bash
llm-usage daily --source-dir pi=/path/to/pi/sessions --source-dir codex=/path/to/codex/sessions
```

Directory override rules:

- `--source-dir` is directory-only (currently `pi` and `codex`).
- `--source-dir opencode=...` is invalid and points to `--opencode-db`.
- `--opencode-db <path>` sets an explicit OpenCode SQLite DB path.

OpenCode DB override:

```bash
llm-usage daily --opencode-db /path/to/opencode.db
```

OpenCode path precedence:

1. explicit `--opencode-db`
2. deterministic OS-specific default path candidates

Backfill example from a historical DB snapshot:

```bash
llm-usage monthly --source opencode --opencode-db /archives/opencode-2026-01.db --since 2026-01-01 --until 2026-01-31
```

OpenCode safety notes:

- OpenCode DB is opened in read-only mode
- unreadable/missing explicit paths fail fast with actionable errors
- OpenCode CLI is optional for troubleshooting and not required for runtime parsing

### Filter by source

Only codex rows:

```bash
llm-usage monthly --source codex
```

Only pi rows:

```bash
llm-usage monthly --source pi
```

Only OpenCode rows:

```bash
llm-usage monthly --source opencode
```

Multiple sources (repeat or comma-separated):

```bash
llm-usage monthly --source pi --source codex
llm-usage monthly --source pi,codex
```

### Filter by provider (optional)

```bash
llm-usage monthly --provider openai
llm-usage monthly --provider github
llm-usage monthly --provider kimi
```

### Filter by model (optional)

`--model` supports repeatable/comma-separated filters. Matching is case-insensitive.

- if an exact model exists for a filter value after source/provider/date filtering, exact matching is used
- otherwise, substring matching is used

```bash
# substring match (all Claude-family models)
llm-usage monthly --model claude

# exact match when present
llm-usage monthly --model claude-sonnet-4.5

# multiple filters
llm-usage monthly --model claude --model gpt-5
llm-usage monthly --model claude,gpt-5
```

### Per-model columns (opt-in detailed table layout)

Default output is compact (model names only in the Models column).

Use `--per-model-columns` to render per-model multiline metrics in each numeric column:

```bash
llm-usage monthly --per-model-columns
llm-usage monthly --markdown --per-model-columns
```

## Output features

### Terminal UI

The CLI provides an enhanced terminal output with:

- **Boxed report header** showing the report type and timezone
- **Session summary** displayed at startup (session files and event counts per source)
- **Pricing source info** indicating whether data was loaded from cache or fetched remotely
- **Environment variable overrides** displayed when active
- **Models displayed as bullet points** for better readability
- **Rounded table borders** and improved color scheme

Example output:

```text
ℹ Found 12 session file(s) with 45 event(s)
•   pi: 8 file(s), 32 events
•   codex: 4 file(s), 13 events
ℹ Loaded pricing from cache

┌──────────────────────────────────────────────────────────┐
│ Monthly Token Usage Report (Timezone: Africa/Casablanca) │
└──────────────────────────────────────────────────────────┘

╭────────────┬──────────┬──────────────────────╮
│ Period     │ Source   │ Models               │
├────────────┼──────────┼──────────────────────┤
│ Feb 2026   │ pi       │ • gpt-5.2            │
│            │          │ • gpt-5.2-codex      │
╰────────────┴──────────┴──────────────────────╯
```

### Report structure

Each report includes:

- source rows (`pi`, `codex`, `opencode`) for each period
- a per-period combined subtotal row (only when multiple sources exist in that period)
- a final grand total row across all periods

Columns:

- Period
- Source
- Models
- Input
- Output
- Reasoning
- Cache Read
- Cache Write
- Total
- Cost

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run format:check
```
