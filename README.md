<div align="center">

<img src="https://ayagmar.github.io/llm-usage-metrics/favicon.svg" width="64" height="64" alt="llm-usage-metrics logo">

# llm-usage-metrics

**Track and analyze your local LLM usage across coding agents**

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ayagmar/llm-usage-metrics)
[![npm version](https://img.shields.io/npm/v/llm-usage-metrics.svg?style=flat-square&color=0ea5e9)](https://www.npmjs.com/package/llm-usage-metrics)
[![npm downloads](https://img.shields.io/npm/dt/llm-usage-metrics.svg?style=flat-square&color=10b981)](https://www.npmjs.com/package/llm-usage-metrics)
[![CI](https://img.shields.io/github/actions/workflow/status/ayagmar/llm-usage-metrics/ci.yml?style=flat-square&label=CI)](https://github.com/ayagmar/llm-usage-metrics/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/codecov/c/github/ayagmar/llm-usage-metrics?style=flat-square)](https://codecov.io/gh/ayagmar/llm-usage-metrics)

[📖 Documentation](https://ayagmar.github.io/llm-usage-metrics/) ·
[⚡ Quick Start](#quick-start) ·
[📊 Examples](#usage) ·
[🤝 Contributing](./CONTRIBUTING.md)

</div>

---

Aggregate token usage and costs from your local coding agent sessions. Supports **pi**, **codex**, **Gemini CLI**, **Droid CLI**, **OpenCode**, **OpenClaw**, **Claude Code**, **GitHub Copilot CLI**, **Goose**, **Amp**, **Qwen CLI**, **Kimi CLI/Kimi Code**, **Cline**, **RooCode**, **KiloCode**, and **Antigravity** with zero configuration required.

## ✨ Features

- **Zero-Config Discovery** — Automatically finds `.pi`, `.codex`, `.gemini`, `.factory`, OpenCode, OpenClaw, Claude, Copilot, Goose, Amp, Qwen, Kimi, Cline, RooCode, KiloCode, and Antigravity session data
- **LiteLLM Pricing** — Real-time pricing sync with offline caching support
- **Flexible Reports** — Daily, weekly, and monthly aggregations
- **Efficiency Reports** — Correlate cost/tokens with repository commit outcomes
- **Optimize Reports** — Counterfactual candidate-model pricing against observed token mix
- **Trends Reports** — Daily cost or token trend views with combined or per-source output
- **Session Reports** — Group usage by conversation session to find high-cost work
- **Wrapped Recaps** — Yearly usage recap with a shareable SVG
- **Doctor Command** — Check source discovery health when reports show no sessions
- **Multiple Outputs** — Terminal tables, JSON, or Markdown
- **Smart Filtering** — By source, billing provider, model, and date ranges

## 🚀 Quick Start

```bash
# Install globally
npm install -g llm-usage-metrics

# Or run without installing
npx llm-usage-metrics@latest daily

# Generate your first report
llm-usage daily
```

<div align="center">

![Terminal output showing token usage and cost breakdown](https://ayagmar.github.io/llm-usage-metrics/screenshot.png)

</div>

## 📋 Supported Sources

| Source          | Pattern                                                                                  | Discovery                            |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| **pi**          | `~/.pi/agent/sessions/**/*.jsonl` (+ `~/.omp/agent/sessions`)                            | Automatic                            |
| **codex**       | `~/.codex/sessions/**/*.jsonl`                                                           | Automatic                            |
| **Gemini CLI**  | `~/.gemini/tmp/*/chats/*.json` (or `$GEMINI_CLI_HOME` when set)                          | Automatic                            |
| **Droid CLI**   | `~/.factory/sessions/**/*.settings.json`                                                 | Automatic                            |
| **OpenCode**    | `~/.local/share/opencode/opencode*.db`                                                   | Auto or explicit `--opencode-db`     |
| **OpenClaw**    | `~/.openclaw/agents/**/*.jsonl` (+ legacy `~/.clawdbot`/`~/.moltbot`/`~/.moldbot` homes) | Automatic                            |
| **Claude Code** | `~/.claude/{projects,transcripts}/**/*.jsonl`                                            | Automatic                            |
| **Copilot CLI** | `~/.copilot/otel/*.jsonl` (+ `$COPILOT_OTEL_FILE_EXPORTER_PATH` file when set)           | Automatic                            |
| **Goose**       | `~/.local/share/goose/sessions/sessions.db` (or `$GOOSE_PATH_ROOT/data/sessions`)        | Auto or explicit `--goose-db`        |
| **Amp**         | `~/.local/share/amp/threads/*.json`                                                      | Auto or explicit `--amp-dir`         |
| **Qwen CLI**    | `~/.qwen/projects/*/chats/*.jsonl`                                                       | Auto or explicit `--qwen-dir`        |
| **Kimi**        | `~/.kimi/sessions/**/wire.jsonl` + `~/.kimi-code/sessions/**/wire.jsonl`                 | Auto or explicit `--kimi-dir`        |
| **Cline**       | VS Code global storage `saoudrizwan.claude-dev/tasks/**/ui_messages.json`                | Auto or explicit `--cline-dir`       |
| **RooCode**     | VS Code global storage `rooveterinaryinc.roo-cline/tasks/**/ui_messages.json`            | Auto or explicit `--roocode-dir`     |
| **KiloCode**    | VS Code global storage `kilocode.kilo-code/tasks/**/ui_messages.json`                    | Auto or explicit `--kilocode-dir`    |
| **Antigravity** | `~/.gemini/antigravity-cli/conversations/*.db` (or `$GEMINI_CLI_HOME`)                   | Auto or explicit `--antigravity-dir` |

SQLite-backed sources (OpenCode, Goose, Antigravity) require Node.js 24+ runtime with built-in `node:sqlite`.

For `droid`, `Input`, `Output`, `Reasoning`, `Cache Read`, and `Cache Write` come directly from session files, and `totalTokens` is billable raw tokens (`Input + Output + Cache Read + Cache Write`, excluding `Reasoning`). Factory dashboard totals may differ because Factory applies standard-token normalization/multipliers.

## 🎯 Usage

### Basic Reports

```bash
# Daily report (default terminal table)
llm-usage daily

# Weekly with timezone
llm-usage weekly --timezone Europe/Paris

# Monthly date range
llm-usage monthly --since 2026-01-01 --until 2026-01-31
```

### Compare

```bash
# Compare the current local calendar month to the previous month
llm-usage compare

# Compare explicit windows
llm-usage compare --since 2026-06-01 --until 2026-06-30 --vs-since 2026-05-01 --vs-until 2026-05-31
```

`compare` applies the same source, provider, model, pricing, timezone, and `--history` filters to both windows. When `--vs-since` and `--vs-until` are omitted, the baseline is the immediately preceding window.

### Output Formats

```bash
# JSON for pipelines
llm-usage daily --json

# Markdown for documentation
llm-usage daily --markdown

# Detailed per-model breakdown
llm-usage monthly --per-model-columns

# Write a share SVG image
llm-usage monthly --share
```

Usage tables rank per-period model breakdowns by total tokens so the dominant models appear first in terminal and Markdown output.

### Trends

```bash
# Last 30 local days of cost by default
llm-usage trends

# Token trends for the last 7 days
llm-usage trends --metric tokens --days 7

# Per-source trends in JSON
llm-usage trends --by-source --json

# Write a combined trends share SVG
llm-usage trends --share --days 7
```

Trends is terminal-first and supports `--json` and `--share`. It does not support `--markdown`.
`--share` renders the combined trends view; run without `--by-source`.

### Session Reports

```bash
# Group usage by conversation session (top 20 by cost by default)
llm-usage session

# Show every session
llm-usage session --top 0

# Look up sessions whose id contains a value (case-insensitive substring)
llm-usage session --id 486c

# Group usage by repository root instead of by session
llm-usage session --by-repo --top 5

# Keep only the highest-cost sessions in JSON output
llm-usage session --top 5 --json

# Markdown table for notes or docs
llm-usage session --markdown
```

Session reports group events by source and session id, then sort sessions by total cost descending.
By default only the top 20 rows are shown (in terminal, Markdown, and JSON output alike) and a stderr note reports how many rows were hidden; use `--top 0` to print everything.
`--id` filters sessions by case-insensitive substring match on the full session id (repeatable or comma-separated), renders matching ids untruncated, and disables the default limit (an explicit `--top` still applies). It cannot be combined with `--by-repo`.
`--by-repo` prints one row per repository root with distinct session counts and the contributing sources; events without a repository fall into a `(no repo)` bucket. The table shows the directory basename while JSON keeps the full path.
The session table shows the repo, last activity, total tokens, cost, and up to two models per session; JSON output keeps all fields (event counts, cache buckets, the full model list, and full repository paths).
Date, source, provider, and model filters apply to events before grouping, so a session spanning a boundary shows only the matching in-range usage.
Session reports do not include a TOTAL row because the rows represent conversations rather than calendar periods.

### Wrapped Recap

```bash
# Current-year recap in the report timezone
llm-usage wrapped

# Fixed-year recap as JSON
llm-usage wrapped --year 2026 --json

# Write the share SVG
llm-usage wrapped --year 2026 --share
```

Wrapped computes yearly totals, active days, longest streak, top models, top sources, and a 12-month intensity strip.
The share output is an offline SVG named `llm-usage-wrapped-<year>.svg`; PNG rendering and embedded logo/font assets are intentionally out of scope.

### Doctor

```bash
# Check source discovery health without parsing sessions
llm-usage doctor

# JSON for support/debugging pipelines
llm-usage doctor --json
```

Doctor prints one line per source and exits 0 even when a source is unhealthy.

```text
pi        ok     12 file(s)
opencode  error  OpenCode database is missing or unreadable: /path/to/opencode.db

15/16 sources healthy
```

### Efficiency Reports

```bash
# Daily efficiency in current repository
llm-usage efficiency daily

# Weekly efficiency for a specific repository path
llm-usage efficiency weekly --repo-dir /path/to/repo

# Include merge commits and export JSON
llm-usage efficiency monthly --include-merge-commits --json

# Write a monthly share SVG
llm-usage efficiency monthly --share
```

Efficiency reports are repo-attributed: usage events are mapped to a Git repository root using source metadata (`cwd`/path info), and only events attributed to the selected repo are included in efficiency totals.

#### Reading efficiency output

- `Commits`, `+Lines`, `-Lines`, `ΔLines` come from local Git shortstat outcomes (for your configured Git author).
- `Input`, `Output`, `Reasoning`, `Cache Read`, `Cache Write`, `Total`, and `Cost` come from repo-attributed usage events.
- `Tokens/Commit` uses `(Input + Output + Reasoning) / Commits` and excludes cache read/write tokens.
- `$/Commit` uses `Cost / Commits`.
- `$/1k Lines` uses `Cost / (ΔLines / 1000)`.
- `Commits/$` uses `Commits / Cost` (shown only when `Cost > 0`).

Efficiency period rows are emitted only when both Git outcomes and repo-attributed usage signal exist for that period.
When a denominator is zero, derived values in emitted rows render as `-`.  
When pricing is incomplete, terminal/markdown output prefixes affected USD metrics with `~`.

For source-by-source comparisons, run the same report per source:

```bash
llm-usage efficiency monthly --repo-dir /path/to/repo --source pi
llm-usage efficiency monthly --repo-dir /path/to/repo --source codex
llm-usage efficiency monthly --repo-dir /path/to/repo --source gemini
llm-usage efficiency monthly --repo-dir /path/to/repo --source droid
llm-usage efficiency monthly --repo-dir /path/to/repo --source opencode
llm-usage efficiency monthly --repo-dir /path/to/repo --source openclaw
llm-usage efficiency monthly --repo-dir /path/to/repo --source claude
llm-usage efficiency monthly --repo-dir /path/to/repo --source copilot
llm-usage efficiency monthly --repo-dir /path/to/repo --source goose
llm-usage efficiency monthly --repo-dir /path/to/repo --source amp
llm-usage efficiency monthly --repo-dir /path/to/repo --source qwen
llm-usage efficiency monthly --repo-dir /path/to/repo --source kimi
llm-usage efficiency monthly --repo-dir /path/to/repo --source cline
llm-usage efficiency monthly --repo-dir /path/to/repo --source roocode
llm-usage efficiency monthly --repo-dir /path/to/repo --source kilocode
llm-usage efficiency monthly --repo-dir /path/to/repo --source antigravity
```

Note: usage filters (`--source`, `--provider`, `--model`, `--pi-dir`, `--codex-dir`, `--copilot-dir`, `--gemini-dir`, `--droid-dir`, `--claude-dir`, `--openclaw-dir`, `--amp-dir`, `--qwen-dir`, `--kimi-dir`, `--cline-dir`, `--roocode-dir`, `--kilocode-dir`, `--antigravity-dir`, `--opencode-db`, `--goose-db`, `--source-dir`) also constrain commit attribution: only commit days with matching repo-attributed usage events are counted.

### Optimize Reports

```bash
# Counterfactual pricing across candidate models
llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex

# Keep only the cheapest candidate in JSON output
llm-usage optimize weekly --provider openai --candidate-model gpt-4.1,gpt-5-codex --top 1 --json

# Write a monthly share SVG
llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --share
```

`--provider` filters by billing entity. Provider aliases are normalized to billing roots (for example, `openai-codex` is treated as `openai`).

### Filtering

```bash
# By source
llm-usage monthly --source pi,codex,gemini,droid,openclaw,claude,copilot,goose,amp,qwen,kimi,cline,roocode,kilocode,antigravity

# By provider
llm-usage monthly --provider openai

# By model
llm-usage monthly --model claude

# Combined filters
llm-usage monthly --source opencode --provider openai --model gpt-4.1
```

Use `--source` to scope where events came from (`pi`, `codex`, `gemini`, `droid`, `opencode`, `openclaw`, `claude`, `copilot`, `goose`, `amp`, `qwen`, `kimi`, `cline`, `roocode`, `kilocode`, `antigravity`), and `--provider` to scope the billing entity behind those events.

### Custom Paths

```bash
# Custom directories
llm-usage daily --source-dir pi=/path/to/pi --source-dir codex=/path/to/codex --source-dir gemini=/path/to/.gemini --source-dir droid=/path/to/.factory/sessions --source-dir openclaw=/path/to/.openclaw/agents --source-dir claude=/path/to/.claude/projects --source-dir copilot=/path/to/.copilot/otel --source-dir amp=/path/to/amp/threads --source-dir qwen=/path/to/.qwen/projects --source-dir kimi=/path/to/kimi/sessions --source-dir cline=/path/to/cline/tasks --source-dir roocode=/path/to/roocode/tasks --source-dir kilocode=/path/to/kilocode/tasks --source-dir antigravity=/path/to/antigravity/conversations

# Explicit Gemini/Droid/Claude/OpenClaw/Copilot/Amp/Qwen/Kimi/Cline/RooCode/KiloCode/Antigravity/OpenCode/Goose paths
llm-usage daily --gemini-dir /path/to/.gemini
llm-usage daily --droid-dir /path/to/.factory/sessions
llm-usage daily --claude-dir /path/to/.claude/projects
llm-usage daily --openclaw-dir /path/to/.openclaw/agents
llm-usage daily --copilot-dir /path/to/.copilot/otel
llm-usage daily --amp-dir /path/to/amp/threads
llm-usage daily --qwen-dir /path/to/.qwen/projects
llm-usage daily --kimi-dir /path/to/kimi/sessions
llm-usage daily --cline-dir /path/to/cline/tasks
llm-usage daily --roocode-dir /path/to/roocode/tasks
llm-usage daily --kilocode-dir /path/to/kilocode/tasks
llm-usage daily --antigravity-dir /path/to/antigravity/conversations
llm-usage daily --opencode-db /path/to/opencode.db
llm-usage daily --goose-db /path/to/goose/sessions.db
```

### Offline Mode

```bash
# Use cached pricing only
llm-usage monthly --pricing-offline

# Continue even if pricing fetch fails
llm-usage monthly --ignore-pricing-failures

# Override per-model pricing from a local JSON file
llm-usage monthly --pricing-overrides ./pricing-overrides.json
```

## 🧪 Production Benchmarks

Benchmarked on **February 27, 2026** on a local production machine:

- OS: CachyOS (Linux 6.19.2-2-cachyos)
- CPU: Intel Core Ultra 9 185H (22 logical CPUs)
- RAM: 62 GiB
- Storage: NVMe SSD

Compared scenarios:

```bash
# direct source-to-source parity (openai provider)
ccusage-codex monthly
llm-usage monthly --provider openai --source codex

# multi-source comparison for one provider (openai)
ccusage-codex monthly
llm-usage monthly --provider openai --source pi,codex,gemini,opencode
```

Timed benchmark summary (5 runs per scenario).

Direct source-to-source parity (`--source codex`):

| Tool                                                                   | Cache mode | Median (s) | Mean (s) |
| ---------------------------------------------------------------------- | ---------- | ---------: | -------: |
| `ccusage-codex monthly`                                                | no cache   |     16.785 |   17.288 |
| `ccusage-codex monthly --offline`                                      | with cache |     16.995 |   17.594 |
| `llm-usage monthly --provider openai --source codex`                   | no cache   |      3.651 |    3.760 |
| `llm-usage monthly --provider openai --source codex --pricing-offline` | with cache |      0.746 |    0.724 |

Speedups (median): `4.60x` faster cold, `22.78x` faster cached.

Multi-source OpenAI (`--source pi,codex,gemini,opencode`):

| Tool                                                                                      | Cache mode | Median (s) | Mean (s) |
| ----------------------------------------------------------------------------------------- | ---------- | ---------: | -------: |
| `ccusage-codex monthly`                                                                   | no cache   |     17.297 |   17.463 |
| `ccusage-codex monthly --offline`                                                         | with cache |     16.698 |   16.745 |
| `llm-usage monthly --provider openai --source pi,codex,gemini,opencode`                   | no cache   |      4.767 |    4.864 |
| `llm-usage monthly --provider openai --source pi,codex,gemini,opencode --pricing-offline` | with cache |      0.941 |    0.951 |

Speedups (median): `3.63x` faster cold, `17.75x` faster cached.

Full methodology, cache-mode definition, and scope caveats are documented in the Astro docs: [Benchmarks](https://ayagmar.github.io/llm-usage-metrics/benchmarks/).

Re-run direct parity benchmark locally:

```bash
pnpm run perf:production-benchmark -- --runs 5 --llm-source codex
```

Re-run multi-source OpenAI benchmark locally:

```bash
pnpm run perf:production-benchmark -- --runs 5 --llm-source pi,codex,gemini,opencode
```

Generate machine-readable artifacts:

```bash
pnpm run perf:production-benchmark -- \
  --runs 5 \
  --llm-source codex \
  --json-output ./tmp/production-benchmark-openai-codex.json \
  --markdown-output ./tmp/production-benchmark-openai-codex.md

pnpm run perf:production-benchmark -- \
  --runs 5 \
  --llm-source pi,codex,gemini,opencode \
  --json-output ./tmp/production-benchmark-openai-multi-source.json \
  --markdown-output ./tmp/production-benchmark-openai-multi-source.md
```

## ⚙️ Configuration

`llm-usage-metrics` reads persistent defaults from a JSON config file:

```text
<config-root>/llm-usage-metrics/config.json
```

Set `LLM_USAGE_CONFIG_PATH=/path/to/config.json` to use a different file.
Missing config files are ignored, malformed JSON fails with an actionable
error, and unknown keys are reported on `stderr`.

Example:

```json
{
  "$schema": "https://ayagmar.github.io/llm-usage-metrics/config-schema.json",
  "timezone": "Africa/Casablanca",
  "sources": ["codex", "claude"],
  "sourceDirs": {
    "codex": "/path/to/.codex/sessions",
    "claude": "/path/to/.claude/projects"
  },
  "pricing": {
    "offline": true
  },
  "eventStore": {
    "enabled": true,
    "path": "/path/to/events.db"
  },
  "parseMaxParallel": 8
}
```

Precedence is `CLI flags` → `environment variables` → `config file` →
`built-in defaults`. Applied config values are shown on `stderr` as an
`Active config:` block.

### Environment Overrides

Environment variables remain available for CI, scripts, and temporary runtime
overrides.

| Variable                             | Config key                    |
| ------------------------------------ | ----------------------------- |
| `LLM_USAGE_CONFIG_PATH`              | Selects the config file       |
| `LLM_USAGE_SKIP_UPDATE_CHECK`        | `update.skipCheck`            |
| `LLM_USAGE_UPDATE_CACHE_TTL_MS`      | `update.cacheTtlMs`           |
| `LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS`  | `update.fetchTimeoutMs`       |
| `LLM_USAGE_PRICING_CACHE_TTL_MS`     | `pricing.cacheTtlMs`          |
| `LLM_USAGE_PRICING_FETCH_TIMEOUT_MS` | `pricing.fetchTimeoutMs`      |
| `LLM_USAGE_PARSE_MAX_PARALLEL`       | `parseMaxParallel`            |
| `LLM_USAGE_EVENT_STORE`              | `eventStore.enabled`          |
| `LLM_USAGE_EVENT_STORE_PATH`         | `eventStore.path`             |
| `LLM_USAGE_UPDATE_CACHE_SCOPE`       | Update cache mode override    |
| `LLM_USAGE_UPDATE_CACHE_SESSION_KEY` | Update cache session key      |
| `LLM_USAGE_PROFILE_RUNTIME`          | Runtime profiling diagnostics |

### SQLite Event Store

`llm-usage` stores parsed file events in
`<platform-cache-root>/llm-usage-metrics/events.db` so unchanged source files do
not need to be reparsed on every run. The store also retains departed-file rows
for `--history` reports. On Linux with no `XDG_CACHE_HOME`, that is usually
`~/.cache/llm-usage-metrics/events.db`.

Use `--history` on report commands to include usage from files that no longer
exist on disk. History follows the same source, provider, model, date, pricing,
and aggregation behavior as live-file reports. If a file was moved, renamed, or
copied, the store suppresses the departed copy by content hash so it is not
double counted. History quality depends on how long the event store has been
running on your machine.

- Set `LLM_USAGE_EVENT_STORE=0` to disable the store for cold-run benchmarking
  or debugging. `--history` requires the store to be enabled.
- Set `LLM_USAGE_EVENT_STORE_PATH=/path/to/events.db` to use an isolated store.
- Back up `events.db` if retained history matters. Deleting it deletes local
  history and starts a new ledger from the next run.
- The first run after upgrading the store schema migrates `events.db` in place
  and may take a few seconds on large stores.
- Older JSON cache shards from pre-store versions are no longer read and can be
  deleted manually.

See the full config and environment override reference in the [documentation](https://ayagmar.github.io/llm-usage-metrics/configuration/).

### Update Checks

The CLI performs lightweight update checks with smart defaults:

- 1-hour cache TTL
- Fresh cached update results are used immediately without any network call
- Stale or missing cache triggers a bounded fetch (default 1s timeout) so the update hint stays consistent across commands, instead of silently skipping the run that refreshes the cache
- Runs concurrently with the report, so it never delays your output
- When an update is available, prints a one-line hint to stderr after the report with the `npm install -g` command — it never prompts, installs, or restarts
- Skipped for `--help`, `--version`, `npx`, and direct source/development runs

Disable with:

```bash
LLM_USAGE_SKIP_UPDATE_CHECK=1 llm-usage daily
```

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Run quality checks
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check

# Build
pnpm run build

# Run locally
pnpm cli daily
```

## 📚 Documentation

- **[Getting Started](https://ayagmar.github.io/llm-usage-metrics/getting-started/)** — Installation and first steps
- **[CLI Reference](https://ayagmar.github.io/llm-usage-metrics/cli-reference/)** — Complete command reference
- **[Efficiency](https://ayagmar.github.io/llm-usage-metrics/efficiency/)** — Efficiency report semantics and interpretation
- **[Optimize](https://ayagmar.github.io/llm-usage-metrics/optimize/)** — Counterfactual candidate-model pricing semantics
- **[Data Sources](https://ayagmar.github.io/llm-usage-metrics/sources/)** — Source configuration
- **[Configuration](https://ayagmar.github.io/llm-usage-metrics/configuration/)** — Config file and environment overrides
- **[Security](https://ayagmar.github.io/llm-usage-metrics/security/)** — Current security controls, dependency hygiene, and contributor steps
- **[Benchmarks](https://ayagmar.github.io/llm-usage-metrics/benchmarks/)** — Production benchmark methodology and results
- **[Architecture](https://ayagmar.github.io/llm-usage-metrics/architecture/)** — Technical overview

## 🔐 Security

Current repo protections include exact direct dependency pins, frozen-lockfile installs in CI, committed lockfile integrity hashes, SHA-pinned GitHub Actions, Dependabot for dependency and workflow updates, dedicated security workflows (`pnpm audit`, Dependency Review, and CodeQL), and OIDC-based npm trusted publishing.
See the full security guide: **[Security](https://ayagmar.github.io/llm-usage-metrics/security/)**.

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

The codebase is structured to add more sources through the `SourceAdapter` pattern.

## 📄 License

MIT © [Abdeslam Yagmar](https://github.com/ayagmar)
