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

Aggregate token usage and costs from your local coding agent sessions. Supports **pi**, **codex**, **Gemini CLI**, **Droid CLI**, and **OpenCode** with zero configuration required.

## ✨ Features

- **Zero-Config Discovery** — Automatically finds `.pi`, `.codex`, `.gemini`, `.factory`, and OpenCode session data
- **LiteLLM Pricing** — Real-time pricing sync with offline caching support
- **Flexible Reports** — Daily, weekly, and monthly aggregations
- **Efficiency Reports** — Correlate cost/tokens with repository commit outcomes
- **Optimize Reports** — Counterfactual candidate-model pricing against observed token mix
- **Trends Reports** — Daily cost or token trend views with combined or per-source output
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

| Source         | Pattern                                  | Discovery                        |
| -------------- | ---------------------------------------- | -------------------------------- |
| **pi**         | `~/.pi/agent/sessions/**/*.jsonl`        | Automatic                        |
| **codex**      | `~/.codex/sessions/**/*.jsonl`           | Automatic                        |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.json`           | Automatic                        |
| **Droid CLI**  | `~/.factory/sessions/**/*.settings.json` | Automatic                        |
| **OpenCode**   | `~/.opencode/opencode.db`                | Auto or explicit `--opencode-db` |

OpenCode source support requires Node.js 24+ runtime with built-in `node:sqlite`.

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

### Trends

```bash
# Last 30 local days of cost by default
llm-usage trends

# Token trends for the last 7 days
llm-usage trends --metric tokens --days 7

# Per-source trends in JSON
llm-usage trends --by-source --json
```

Trends is terminal-first and supports `--json`. It does not support `--markdown` or `--share`.

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
- `All Tokens/Commit` uses `Total / Commits` and includes cache read/write tokens.
- `Non-Cache/Commit` uses `(Input + Output + Reasoning) / Commits` and excludes cache read/write tokens.
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
```

Note: usage filters (`--source`, `--provider`, `--model`, `--pi-dir`, `--codex-dir`, `--gemini-dir`, `--droid-dir`, `--opencode-db`, `--source-dir`) also constrain commit attribution: only commit days with matching repo-attributed usage events are counted.

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
llm-usage monthly --source pi,codex,gemini,droid

# By provider
llm-usage monthly --provider openai

# By model
llm-usage monthly --model claude

# Combined filters
llm-usage monthly --source opencode --provider openai --model gpt-4.1
```

Use `--source` to scope where events came from (`pi`, `codex`, `gemini`, `droid`, `opencode`), and `--provider` to scope the billing entity behind those events.

### Custom Paths

```bash
# Custom directories
llm-usage daily --source-dir pi=/path/to/pi --source-dir codex=/path/to/codex --source-dir gemini=/path/to/.gemini --source-dir droid=/path/to/.factory/sessions

# Explicit Gemini/Droid/OpenCode paths
llm-usage daily --gemini-dir /path/to/.gemini
llm-usage daily --droid-dir /path/to/.factory/sessions
llm-usage daily --opencode-db /path/to/opencode.db
```

### Offline Mode

```bash
# Use cached pricing only
llm-usage monthly --pricing-offline

# Continue even if pricing fetch fails
llm-usage monthly --ignore-pricing-failures
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

### Environment Variables

| Variable                         | Description                       |
| -------------------------------- | --------------------------------- |
| `LLM_USAGE_SKIP_UPDATE_CHECK`    | Skip update check (`1`)           |
| `LLM_USAGE_PRICING_CACHE_TTL_MS` | Pricing cache duration            |
| `LLM_USAGE_PARSE_MAX_PARALLEL`   | Max parallel file parses (`1-64`) |
| `LLM_USAGE_PARSE_CACHE_ENABLED`  | Enable parse cache (`1/0`)        |

Parse cache is source-sharded on disk (`parse-file-cache.<source>.json`) so source-scoped runs avoid loading unrelated cache blobs.

See full environment variable reference in the [documentation](https://ayagmar.github.io/llm-usage-metrics/configuration/).

### Update Checks

The CLI performs lightweight update checks with smart defaults:

- 1-hour cache TTL
- Skipped for `--help`, `--version`, and `npx` runs
- Prompts only in interactive TTY sessions

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
- **[Configuration](https://ayagmar.github.io/llm-usage-metrics/configuration/)** — Environment variables
- **[Benchmarks](https://ayagmar.github.io/llm-usage-metrics/benchmarks/)** — Production benchmark methodology and results
- **[Architecture](https://ayagmar.github.io/llm-usage-metrics/architecture/)** — Technical overview

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

The codebase is structured to add more sources through the `SourceAdapter` pattern.

## 📄 License

MIT © [Abdeslam Yagmar](https://github.com/ayagmar)
