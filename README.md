<p align="center">
  <img src="https://ayagmar.github.io/llm-usage-metrics/favicon.svg" width="72" height="72" alt="LLM Usage Metrics logo">
</p>

<h1 align="center">llm-usage-metrics</h1>

<p align="center">
  Local usage reports for AI coding tools.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/llm-usage-metrics"><img src="https://img.shields.io/npm/v/llm-usage-metrics.svg?style=flat-square&color=b65331" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/llm-usage-metrics"><img src="https://img.shields.io/npm/dt/llm-usage-metrics.svg?style=flat-square&color=5f655b" alt="npm downloads"></a>
  <a href="https://github.com/ayagmar/llm-usage-metrics/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ayagmar/llm-usage-metrics/ci.yml?style=flat-square&label=CI" alt="CI status"></a>
  <a href="https://codecov.io/gh/ayagmar/llm-usage-metrics"><img src="https://img.shields.io/codecov/c/github/ayagmar/llm-usage-metrics?style=flat-square" alt="test coverage"></a>
  <a href="https://deepwiki.com/ayagmar/llm-usage-metrics"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <a href="https://ayagmar.github.io/llm-usage-metrics/">Documentation</a> ·
  <a href="https://ayagmar.github.io/llm-usage-metrics/getting-started/">Getting started</a> ·
  <a href="https://ayagmar.github.io/llm-usage-metrics/cli-reference/">CLI reference</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

`llm-usage-metrics` reads local session data from 17 AI coding tools and converts it into one normalized usage history. Use it to review tokens and estimated cost, compare periods, find expensive sessions, correlate usage with local Git activity, or export the result.

The CLI parses session content on your machine. It discovers standard source locations and includes a bundled pricing snapshot, so the first report can run without configuration or network access.

## Quick start

Requires Node.js 22.16+ or 24+ (Node 23 lacks the SQLite busy timeout the ledger uses).

```bash
# Run without installing
npx --yes llm-usage-metrics@latest

# Or install it: the package provides `llm-usage` and the alias `llm-usage-metrics`
npm install -g llm-usage-metrics
llm-usage
```

With no command, `llm-usage` prints cost and tokens for today, the last 7 days, and month to date, then your current and longest streak, best day, and a year-long activity heatmap. `llm-usage daily` breaks the last 7 days down by day and source, and `llm-usage weekly` covers the last 8 weeks; add `--since YYYY-MM-DD` or `--all` for older usage.

If the report is empty, check source discovery. `doctor` lists the paths each source searched and marks it found, not installed, or unparseable:

```bash
llm-usage doctor
```

## Reports

| Question                                                  | Command                                   |
| --------------------------------------------------------- | ----------------------------------------- |
| What did I spend today, this week, and this month?        | `llm-usage`                               |
| How much did I use by day, week, or month?                | `llm-usage daily`, `weekly`, `monthly`    |
| How did one period change from another?                   | `llm-usage compare`                       |
| Which conversations or repositories used the most?        | `llm-usage session`                       |
| How is daily usage moving?                                | `llm-usage trends`                        |
| How does repo-attributed usage line up with Git activity? | `llm-usage efficiency monthly`            |
| What would the same token mix cost on another model?      | `llm-usage optimize monthly`              |
| What did the year add up to?                              | `llm-usage wrapped`                       |
| How do I get the raw normalized events out?               | `llm-usage events`                        |
| Which sources and local stores are healthy?               | `llm-usage doctor`                        |
| Which departed files can leave the event ledger?          | `llm-usage prune`                         |
| What configuration is active, and which file is it from?  | `llm-usage config show`, `config path`    |
| Which JSON Schema does my installed version emit?         | `llm-usage schema usage`, `schema --list` |

Common examples:

```bash
# A chosen calendar range
llm-usage monthly --since 2026-06-01 --until 2026-06-30

# Current month to date compared with the same days of the previous month
llm-usage compare

# Ten highest-cost conversations
llm-usage session --top 10

# Usage grouped by repository
llm-usage session --by-repo

# Last 14 local days as a token series
llm-usage trends --metric tokens --days 14

# Candidate-model pricing against observed usage
llm-usage optimize monthly \
  --provider openai \
  --candidate-model gpt-4.1 \
  --candidate-model gpt-5-codex

# Normalized events as JSONL, e.g. total tokens per line via jq
llm-usage events --since 2026-06-01 | jq '.totalTokens'
```

## Supported sources

| Source                 | Local format  |
| ---------------------- | ------------- |
| pi                     | JSONL         |
| codex                  | JSONL         |
| Gemini CLI             | JSON          |
| Droid CLI              | settings JSON |
| OpenCode               | SQLite        |
| OpenClaw               | JSONL         |
| Claude Code            | JSONL         |
| GitHub Copilot CLI     | OTEL JSONL    |
| Goose                  | SQLite        |
| Amp                    | JSON          |
| Qwen CLI               | JSONL         |
| Kimi CLI and Kimi Code | wire JSONL    |
| Cline                  | task JSON     |
| RooCode                | task JSON     |
| KiloCode               | task JSON     |
| Antigravity            | SQLite        |
| DeepSeek Harness       | JSONL + zstd  |

Each source adapter owns discovery and source-specific token normalization. Reports operate on the same `UsageEvent` shape after parsing. The [source documentation](https://ayagmar.github.io/llm-usage-metrics/sources/) lists default paths, override flags, and adapter-specific semantics.

SQLite-backed sources use the built-in `node:sqlite` module.

## Filters and configuration

```bash
# Filter by source tool
llm-usage monthly --source codex,claude

# Filter by normalized billing provider
llm-usage monthly --provider openai

# Filter by exact model or substring
llm-usage monthly --model codex

# Create a commented TOML config with editor schema support
llm-usage config init
```

`--source` identifies the tool that wrote an event. `--provider` identifies the billing entity behind its model. A Codex session can have `source=codex` and `provider=openai`.

The config precedence order is CLI flags, environment variables, TOML config, then built-in defaults. See [Configuration](https://ayagmar.github.io/llm-usage-metrics/configuration/) for every key and source path override.

## Pricing

The CLI keeps a valid cost supplied by a source. When a source has no cost, it estimates one from LiteLLM pricing.

Pricing loads from a fresh cache, a network refresh, a stale cache, or the bundled snapshot. Use offline mode to skip the network request:

```bash
llm-usage monthly --pricing-offline
```

Cost rendering makes incomplete data visible:

- `$12.34` means the full row has resolved cost.
- `~$12.34` means the known cost is partial.
- `-` means no contributing event has a resolved cost.

The pricing request never includes session content. See [Pricing](https://ayagmar.github.io/llm-usage-metrics/pricing/) for rate matching, overrides, and error behavior.

## Local event ledger

A SQLite event ledger stores normalized events and parse diagnostics. Unchanged files can skip parsing on later runs. Reports also include retained history for files that have left the disk (Claude Code, for example, deletes old transcripts), with moved or copied files suppressed. Leave it out with `--no-history`:

```bash
llm-usage monthly --no-history
```

`prune` is a dry run unless you pass `--apply`:

```bash
llm-usage prune --suppressed
llm-usage prune --departed-before 2026-01-01 --apply
```

Deleting the ledger also deletes retained history. Read [Caching](https://ayagmar.github.io/llm-usage-metrics/caching/) before clearing it as a troubleshooting step.

## Output

```bash
llm-usage daily --all --json
llm-usage daily --markdown
llm-usage daily --compact
llm-usage monthly --share
```

Terminal tables fit the terminal width: on a narrow terminal, token counts are abbreviated and less-used columns are hidden, with a `stderr` note saying what was left out. `--compact` asks for the short table directly.

Report data goes to `stdout`. Diagnostics go to `stderr` as one summary line plus any warnings, which keeps JSON and Markdown safe to redirect; `--quiet` keeps only warnings and `--verbose` adds per-source and skipped-row detail. JSON output is wrapped in a versioned envelope: `{ "schemaVersion": 1, "report": "usage", "data": ... }`. Scripts written against pre-0.8.0 JSON should follow the [migration guide](https://ayagmar.github.io/llm-usage-metrics/migrating-to-0-8/).

Terminal, JSON, and Markdown availability varies by report. Summary, usage, compare, trends, wrapped, efficiency, and optimize can write a 1200×630 share card: an SVG plus an HTML page that shows it in dark and light and exports a PNG in your browser. `--share --no-open` writes the files without opening the page. The [output guide](https://ayagmar.github.io/llm-usage-metrics/output-formats/) contains the format matrix and file names.

## Performance

The repository publishes direct-process and launcher-inclusive runtimes on stable snapshots of real local corpora. The current direct-process comparison shows `ccusage` ahead in every measured daily JSON cell; a separate monthly terminal check shows why timing `npx ccusage@...` can appear much slower than an installed `llm-usage` command. The benchmark records the machine, exact commands, application state, dataset size, and eight-run summary statistics.

Read and reproduce the [benchmark](https://ayagmar.github.io/llm-usage-metrics/benchmarks/) before applying its results to another workload.

## Development

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm run build
```

The website has a [docs overview](https://ayagmar.github.io/llm-usage-metrics/docs/) and a [report chooser](https://ayagmar.github.io/llm-usage-metrics/reports/) for finding the right command. Its landing page and source navigation use the CLI source registry; regenerate CLI and security references after behavior changes.

Site commands:

```bash
pnpm run site:docs:generate
pnpm run site:check
pnpm run site:build
pnpm run site:dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/development.md](./docs/development.md) for the contributor workflow.

## License

[MIT](./LICENSE)
