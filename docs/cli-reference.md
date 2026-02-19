# CLI Reference

## Command structure

```bash
llm-usage <command> [options]
```

Without global install, use:

```bash
npx --yes llm-usage-metrics <command> [options]
```

Runtime note:

- OpenCode (`--source opencode` / `--opencode-db`) requires Node.js 24+ because it uses `node:sqlite`.
- If you build locally, run OpenCode flows via `node dist/index.js ...`.

Commands:

- `daily`
- `weekly`
- `monthly`

## Shared options

- `--pi-dir <path>`: override `.pi` sessions directory
- `--codex-dir <path>`: override `.codex` sessions directory
- `--opencode-db <path>`: OpenCode SQLite DB path override
- `--source-dir <source-id=path>`: override sessions directory for directory-backed sources only (repeatable)
- `--source <name>`: source filter (repeatable or comma-separated)
- `--since <YYYY-MM-DD>`: inclusive start date (local to selected timezone)
- `--until <YYYY-MM-DD>`: inclusive end date (local to selected timezone)
- `--timezone <iana>`: IANA timezone for bucket boundaries
- `--provider <name>`: provider filter (substring match, case-insensitive)
- `--model <name>`: model filter (repeatable or comma-separated, case-insensitive; exact when an exact model exists after source/provider/date filters, otherwise substring)
- `--pricing-url <url>`: use custom LiteLLM pricing JSON source
- `--pricing-offline`: use cache only (no network)
- `--markdown`: render markdown table
- `--json`: render JSON rows
- `--per-model-columns`: opt-in detailed table layout with per-model multiline metrics in numeric columns

## Defaults

- timezone defaults to local system timezone
- provider filter is optional (no provider filtering when omitted)
- model filter is optional (no model filtering when omitted)
- source filter defaults to all parsed sources
- output defaults to terminal table
- table layout defaults to compact models column (names only); use `--per-model-columns` for detailed per-model columns

## Startup update notifier

When installed globally, the CLI checks npm for newer versions using a cached lookup (1-hour default TTL).

- cache path: `<platform-cache-root>/llm-usage-metrics/update-check.json` (Linux default: `~/.cache/llm-usage-metrics/update-check.json` when `XDG_CACHE_HOME` is unset)
- check is skipped for `--help`, `help`, `--version`, and `version` invocations
- check is skipped when the CLI appears to run via `npx`
- interactive TTY sessions can prompt to install + restart
- non-interactive sessions print a one-line update notice

Disable the startup check with:

```bash
LLM_USAGE_SKIP_UPDATE_CHECK=1 llm-usage daily
```

## Environment variables

Operational runtime knobs:

- `LLM_USAGE_SKIP_UPDATE_CHECK`: skip startup update check when set to `1`
- `LLM_USAGE_UPDATE_CACHE_SCOPE`: update-check cache scope (`global` default, `session` to scope by terminal shell session)
- `LLM_USAGE_UPDATE_CACHE_SESSION_KEY`: optional custom session key when cache scope is `session` (defaults to parent shell PID)
- `LLM_USAGE_UPDATE_CACHE_TTL_MS`: update-check cache TTL in milliseconds (clamped `0..2592000000`; use `0` to check on every CLI run)
- `LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS`: update-check fetch timeout in milliseconds (clamped `200..30000`)
- `LLM_USAGE_PRICING_CACHE_TTL_MS`: pricing cache TTL in milliseconds (clamped `60000..2592000000`)
- `LLM_USAGE_PRICING_FETCH_TIMEOUT_MS`: pricing fetch timeout in milliseconds (clamped `200..30000`)
- `LLM_USAGE_PARSE_MAX_PARALLEL`: max parallel file parsing per source adapter (clamped `1..64`)

## Terminal output

When outputting to terminal (default), the CLI emits:

### `stderr` diagnostics

1. **Session summary**: total files/events and per-source breakdown
2. **Pricing source message**: cache / network / offline-cache

### `stdout` report body

1. **Environment overrides** (if any): active environment variables and their values
2. **Report header**: boxed title showing report type and timezone
3. **Data table**: usage statistics with rounded borders and color-coded rows

Row styling policy:

- Source names are color-coded (`pi` = cyan, `codex` = magenta, `opencode` = blue, `combined` = yellow)
- Grand total source label (`TOTAL`) is bold green
- Grand total numeric cells are bold
- Combined subtotal rows are dimmed except the source cell
- Unknown source labels are left unchanged

For `--json` and `--markdown`, only data output is printed (no diagnostics).

## Examples

Daily report:

```bash
llm-usage daily
```

Weekly report in Paris time:

```bash
llm-usage weekly --timezone Europe/Paris
```

Monthly report for a range:

```bash
llm-usage monthly --since 2026-01-01 --until 2026-01-31
```

JSON output for automation:

```bash
llm-usage daily --json
```

Markdown output for docs:

```bash
llm-usage daily --markdown
```

Detailed per-model column layout:

```bash
llm-usage monthly --per-model-columns
llm-usage monthly --markdown --per-model-columns
```

Custom directories:

```bash
llm-usage daily --pi-dir /path/to/pi --codex-dir /path/to/codex
```

Generic source directory overrides:

```bash
llm-usage daily --source-dir pi=/path/to/pi --source-dir codex=/path/to/codex
```

OpenCode DB override:

```bash
llm-usage daily --opencode-db /path/to/opencode.db
```

OpenCode path precedence:

1. explicit `--opencode-db`
2. deterministic OS-specific default OpenCode DB candidate paths

When no default OpenCode DB is found, the source is treated as unavailable (no rows parsed).

Offline pricing mode:

```bash
llm-usage monthly --pricing-offline
```

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

Model filtering (exact-when-exact-available after source/provider/date filtering, otherwise substring):

```bash
llm-usage monthly --model claude
llm-usage monthly --model claude-sonnet-4.5
llm-usage monthly --model claude,gpt-5
```

Backfill and historical reruns:

- use `--since` and `--until` to rerun a historical window from an OpenCode snapshot
- keep point-in-time DB copies and pass them explicitly with `--opencode-db`

Example:

```bash
llm-usage monthly --source opencode --opencode-db /archives/opencode-2026-01.db --since 2026-01-01 --until 2026-01-31
```

## Validation rules

- `--since` and `--until` must be valid calendar dates in `YYYY-MM-DD`
- `--since` must be `<= --until`
- `--timezone` must be a valid IANA timezone
- `--source` values must be non-empty source ids and match known sources (`pi`, `codex`, `opencode`)
- `--model` must contain at least one non-empty filter value
- `--source-dir` values must use `<source-id>=<path>` with non-empty source id and path
- `--source-dir` is currently directory-only (`pi`, `codex`)
- `--source-dir opencode=...` is rejected; use `--opencode-db` for DB-based sources
- `--pricing-url` must be `http` or `https`
- `--markdown` and `--json` are mutually exclusive
- if LiteLLM pricing cannot be loaded (or cache is unavailable in offline mode), report generation fails

## OpenCode troubleshooting and safety

- runtime parsing uses Node `node:sqlite` directly; OpenCode CLI is optional for troubleshooting only
- OpenCode DB is opened in read-only mode
- explicit `--opencode-db` paths are validated and fail fast when unreadable/missing
- schema-drift failures report actionable guidance; inspect schema with OpenCode CLI helpers:
  - `opencode db "select name from sqlite_master where type='table'"`
  - `opencode db --format json "<sql>"`
