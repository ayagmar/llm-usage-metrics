# Architecture

## High-level design

`llm-usage-metrics` is a deterministic reporting pipeline with explicit seams:

1. **Report definitions** describe command identity, shared option profile, examples, and runtime binding.
2. **CLI builders** load and normalize local usage data for one report.
3. **Feature aggregators** reshape normalized usage into report-specific data.
4. **Renderers** emit terminal, JSON, Markdown, or share artifacts.
5. **Shared report runtime** keeps diagnostics on `stderr`, report bodies on `stdout`, and centralizes format/share lifecycle behavior.

This keeps source-specific parsing, pricing, aggregation, rendering, and command wiring separate.

## Report command architecture

### Report definitions

- `src/cli/report-definitions/report-definitions.ts`
  Owns the canonical registry for `daily`, `weekly`, `monthly`, `compare`, `efficiency`, `optimize`, `trends`, `session`, `wrapped`, `doctor`, and `prune`. (`config init` is registered directly in `create-cli.ts`.)
- `src/cli/report-definitions/shared-report-options.ts`
  Registers the shared option surface by profile (`usage`, `specialized`, `trends`).

This metadata is reused by:

- `src/cli/create-cli.ts` to register Commander commands
- `scripts/generate-cli-reference.mjs` to generate the site CLI reference
- root help examples, so CLI help and generated docs do not drift

Commander help text remains the source of truth for option descriptions.

### Shared report runtime

- `src/cli/report-runtime/report-lifecycle.ts`
  Centralizes:
  - `--markdown` / `--json` validation
  - output-format resolution
  - report preparation
  - share artifact write/open/log handling
  - optional terminal overflow warnings
  - final stdout emission

Each report wrapper owns its policy:

- data builder
- renderer
- report-specific diagnostics
- share eligibility rules

The public entry points remain stable, one `build*`/`run*` pair per command:

- `buildUsageReport`, `runUsageReport`
- `buildCompareReport`, `runCompareReport`
- `buildEfficiencyReport`, `runEfficiencyReport`
- `buildOptimizeReport`, `runOptimizeReport`
- `buildTrendsReport`, `runTrendsReport`
- `buildSessionReport`, `runSessionReport`
- `buildWrappedReport`, `runWrappedReport`
- `buildDoctorResults`, `runDoctorReport`
- `buildPruneReport`, `runPruneReport`

## Runtime flows

### Usage

`runUsageReport(granularity, options)`

1. `buildUsageData(...)`
2. `aggregateUsage(..., { includeModelBreakdown: true })`
3. `renderUsageReport(...)`
4. shared report runtime emits diagnostics, optional share SVG, and stdout body

### Efficiency

`runEfficiencyReport(granularity, options)`

1. `buildUsageData(...)`
2. repo attribution (`src/efficiency/repo-attribution.ts`)
3. Git outcomes (`src/efficiency/git-outcome-collector.ts`)
4. `aggregateUsage(..., { includeModelBreakdown: false })`
5. `aggregateEfficiency(...)`
6. `renderEfficiencyReport(...)`
7. shared report runtime emits diagnostics, optional share SVG, and stdout body

### Optimize

`runOptimizeReport(granularity, options)`

1. `buildUsageEventDataset(...)`
2. pricing load and application
3. `aggregateUsage(..., { includeModelBreakdown: false })`
4. `buildCounterfactualRows(...)`
5. `renderOptimizeReport(...)`
6. shared report runtime emits diagnostics, optional share SVG, and stdout body

### Trends

`runTrendsReport(options)`

1. `buildUsageEventDataset(...)`
2. optional pricing load (cost mode only)
3. `aggregateUsage(..., { granularity: 'daily', includeModelBreakdown: false })`
4. `aggregateTrends(...)`
5. `renderTrendsReport(...)`
6. shared report runtime emits diagnostics and stdout body

### Compare

`runCompareReport(options)`

1. `buildCompareData(...)` builds one priced dataset spanning both date windows
2. per-window aggregation and delta computation
3. `renderCompareReport(...)`
4. shared report runtime emits diagnostics and stdout body

### Session

`runSessionReport(options)`

1. `buildSessionData(...)` reuses the usage dataset and pricing
2. per-session grouping (or per-repository with `--by-repo`) with a top-N row limit (`src/session`)
3. `renderSessionReport(...)`
4. shared report runtime emits diagnostics and stdout body

### Wrapped

`runWrappedReport(options)`

1. `buildWrappedData(...)` builds the priced dataset for the recap year's range
2. `aggregateWrapped(...)` (`src/wrapped`)
3. `renderWrappedReport(...)`
4. shared report runtime emits diagnostics, optional share SVG, and stdout body

### Doctor and Prune

Non-report commands with their own runners: `buildDoctorResults(...)` checks source discovery health and runtime configuration and `runDoctorReport` renders it; `buildPruneReport(...)` classifies departed event-store files through the shared history logic and `renderPruneReport` prints candidates and the apply summary.

### Event Store History

`src/persistence/event-store.ts` owns SQLite schema, migration, per-file ingest,
and stored-event revalidation. The store is a local ledger: schema changes run
as migrations, and unknown newer schemas disable store use instead of rebuilding
tables.

`src/persistence/event-store-history.ts` owns `--history` reads. It compares the
current run's discovered `(source, file_path)` pairs with stored files, serves
departed files for selected sources, and suppresses moved or copied files by
content hash. Served history events are appended before the normal
provider/model/date filters, pricing, and aggregation steps, so downstream
report shapes stay unchanged.

## Aggregation profiles

`src/aggregate/aggregate-usage.ts` supports `includeModelBreakdown`.

- usage reports keep model breakdowns
- efficiency, optimize, and trends skip model breakdown computation

This removes unnecessary work and avoids leaking usage-table-specific model metadata into reports that do not need it.

## Generic table rendering

`src/render/unicode-table.ts` is driven by explicit table row metadata:

- `periodKey`
- `rowKind` (`detail`, `combined`, `total`)

That keeps sorting and separator behavior deterministic without coupling the generic table renderer to `UsageReportRow`.

## Module map

- `src/cli`
  Command creation, shared runtime, builders, diagnostics emission; `parse-worker-pool.ts` holds the worker-thread parse pool; `parse/` groups the parse-pipeline concerns (`parse-fingerprint.ts` dependency fingerprinting, `event-store-parse-cache.ts` store read/write caching, `parse-budget.ts` the global parse semaphore, `usage-event-filters.ts` provider/date/model filtering) around the coordinator in `build-usage-data-parsing.ts`
- `src/cli/report-definitions`
  Canonical report metadata and option profiles
- `src/cli/report-runtime`
  Shared report execution lifecycle
- `src/config`
  TOML config loading (`user-config.ts`) and flag/env/config/default resolution (`runtime-overrides.ts`)
- `src/sources`
  Source adapters, discovery, parsing
- `src/domain`
  Canonical usage contracts and normalization
- `src/pricing`
  LiteLLM pricing loader, cache, model matching, cost engine
- `src/persistence`
  SQLite event-store ledger, schema migrations, history suppression
- `src/aggregate`
  Period/source usage aggregation
- `src/efficiency`
  Repo attribution, Git outcomes, efficiency aggregation
- `src/optimize`
  Counterfactual pricing aggregation
- `src/trends`
  Trend series contracts and daily trend aggregation
- `src/session`
  Per-conversation and per-repository usage aggregation
- `src/wrapped`
  Yearly recap aggregation
- `src/render`
  Terminal/JSON/Markdown/share rendering
- `src/update`
  Startup update check
- `src/utils`
  Shared fs/discovery/time helpers and the leveled stderr logger (`logger.ts`)

## Deep dives

The published site documents the core subsystems in depth; keep the deep detail there and the file-level map here:

- [Event Store](https://ayagmar.github.io/llm-usage-metrics/architecture/event-store/)
- [Parse Pipeline](https://ayagmar.github.io/llm-usage-metrics/architecture/parse-pipeline/)
- [Pricing Pipeline](https://ayagmar.github.io/llm-usage-metrics/architecture/pricing-pipeline/)
- [Config & Logging](https://ayagmar.github.io/llm-usage-metrics/architecture/config-and-logging/)

## Core invariants

- deterministic ordering for periods, sources, candidates, and models
- source-specific parsing stays behind adapter contracts
- provider values are normalized to billing entities at the domain boundary
- diagnostics stay on `stderr`
- report bodies stay on `stdout`
- JSON/Markdown output remains data-only on `stdout`
- OpenCode parsing is read-only through built-in `node:sqlite`
- incomplete pricing is surfaced explicitly (`~$...`, warnings, or incomplete flags)
