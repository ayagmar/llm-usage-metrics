# llm-usage-metrics

CLI to aggregate local LLM usage from:

- `~/.pi/agent/sessions/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`

Reports are available for daily, weekly (Monday-start), and monthly periods.

Project documentation is available in [`docs/`](./docs/README.md).

Built-in adapters currently support `.pi` and `.codex`. The codebase is structured to add more sources (for example Claude/Gemini exports) through the `SourceAdapter` pattern. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Install

```bash
npm install -g llm-usage-metrics
```

Or run without global install:

```bash
npx --yes llm-usage-metrics daily
```

(`npx llm-usage daily` works when the project is already installed locally.)

## Update checks

When installed globally, the CLI performs a lightweight npm update check on startup.

Behavior:

- uses a local cache (`~/.cache/llm-usage-metrics/update-check.json`) with TTL
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
- `LLM_USAGE_UPDATE_CACHE_TTL_MS`: update-check cache TTL in milliseconds (clamped: `60000..2592000000`)
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

### Custom session directories

```bash
llm-usage daily --pi-dir /path/to/pi/sessions --codex-dir /path/to/codex/sessions
```

### Filter by source

Only codex rows:

```bash
llm-usage monthly --source codex
```

Only pi rows:

```bash
llm-usage monthly --source pi
```

Multiple sources (repeat or comma-separated):

```bash
llm-usage monthly --source pi --source codex
llm-usage monthly --source pi,codex
```

## Output semantics

Each report includes:

- source rows (`pi`, `codex`) for each period
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
- Total Tokens
- Cost (USD)

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run format:check
```
