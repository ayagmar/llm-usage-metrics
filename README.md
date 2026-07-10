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
</p>

<p align="center">
  <a href="https://ayagmar.github.io/llm-usage-metrics/">Documentation</a> ·
  <a href="https://ayagmar.github.io/llm-usage-metrics/getting-started/">Getting started</a> ·
  <a href="https://ayagmar.github.io/llm-usage-metrics/cli-reference/">CLI reference</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

`llm-usage-metrics` reads local session data from 16 AI coding tools and converts it into one normalized usage history. Use it to review tokens and estimated cost, compare periods, find expensive sessions, correlate usage with local Git activity, or export the result.

The CLI parses session content on your machine. It discovers standard source locations and includes a bundled pricing snapshot, so the first report can run without configuration or network access.

## Quick start

Requires Node.js 24 or newer.

```bash
# Run without installing
npx --yes llm-usage-metrics@latest daily

# Or install the llm-usage command
npm install -g llm-usage-metrics
llm-usage daily
```

If the report is empty, check source discovery:

```bash
llm-usage doctor
```

## Reports

| Question                                                  | Command                                |
| --------------------------------------------------------- | -------------------------------------- |
| How much did I use by day, week, or month?                | `llm-usage daily`, `weekly`, `monthly` |
| How did one period change from another?                   | `llm-usage compare`                    |
| Which conversations or repositories used the most?        | `llm-usage session`                    |
| How is daily usage moving?                                | `llm-usage trends`                     |
| How does repo-attributed usage line up with Git activity? | `llm-usage efficiency monthly`         |
| What would the same token mix cost on another model?      | `llm-usage optimize monthly`           |
| What did the year add up to?                              | `llm-usage wrapped`                    |
| Which sources and local stores are healthy?               | `llm-usage doctor`                     |
| Which departed files can leave the event ledger?          | `llm-usage prune`                      |

Common examples:

```bash
# A chosen calendar range
llm-usage monthly --since 2026-06-01 --until 2026-06-30

# Current local month compared with the previous month
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

A SQLite event ledger stores normalized events and parse diagnostics. Unchanged files can skip parsing on later runs. The ledger also supports retained history for files that have left the disk:

```bash
llm-usage monthly --history
```

`prune` is a dry run unless you pass `--apply`:

```bash
llm-usage prune --suppressed
llm-usage prune --departed-before 2026-01-01 --apply
```

Deleting the ledger also deletes retained history. Read [Caching](https://ayagmar.github.io/llm-usage-metrics/caching/) before clearing it as a troubleshooting step.

## Output

```bash
llm-usage daily --json
llm-usage daily --markdown
llm-usage monthly --share
```

Report data goes to `stdout`. Discovery, pricing, config, and skipped-row diagnostics go to `stderr`, which keeps JSON and Markdown safe to redirect.

Terminal, JSON, and Markdown availability varies by report. Usage, trends, wrapped, efficiency, and optimize can write supported share SVGs. The [output guide](https://ayagmar.github.io/llm-usage-metrics/output-formats/) contains the format matrix and file names.

## Performance

The repository publishes absolute cold and warm runtimes on real local corpora. The comparison includes the runs where `ccusage` is faster and the warm Claude run where the event ledger is faster. It also records the machine, commands, cache state, dataset size, and five-run distribution.

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

Site commands:

```bash
pnpm run site:check
pnpm run site:build
pnpm run site:dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/development.md](./docs/development.md) for the contributor workflow.

## License

[MIT](./LICENSE)
