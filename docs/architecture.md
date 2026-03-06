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
  Owns the canonical registry for `daily`, `weekly`, `monthly`, `efficiency`, `optimize`, and `trends`.
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

Each report wrapper still owns its policy:

- data builder
- renderer
- report-specific diagnostics
- share eligibility rules

The public entry points remain stable:

- `buildUsageReport`, `runUsageReport`
- `buildEfficiencyReport`, `runEfficiencyReport`
- `buildOptimizeReport`, `runOptimizeReport`

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

## Aggregation profiles

`src/aggregate/aggregate-usage.ts` supports `includeModelBreakdown`.

- usage reports keep model breakdowns
- efficiency, optimize, and trends skip model breakdown computation

This removes unnecessary work and avoids leaking usage-table-specific model metadata into reports that do not need it.

## Generic table rendering

`src/render/unicode-table.ts` is now driven by explicit table row metadata:

- `periodKey`
- `rowKind` (`detail`, `combined`, `total`)

That keeps sorting and separator behavior deterministic without coupling the generic table renderer to `UsageReportRow`.

## Module map

- `src/cli`
  Command creation, shared runtime, builders, diagnostics emission
- `src/cli/report-definitions`
  Canonical report metadata and option profiles
- `src/cli/report-runtime`
  Shared report execution lifecycle
- `src/sources`
  Source adapters, discovery, parsing
- `src/domain`
  Canonical usage contracts and normalization
- `src/pricing`
  LiteLLM pricing loader, cache, cost engine
- `src/aggregate`
  Period/source usage aggregation
- `src/efficiency`
  Repo attribution, Git outcomes, efficiency aggregation
- `src/optimize`
  Counterfactual pricing aggregation
- `src/trends`
  Trend series contracts and daily trend aggregation
- `src/render`
  Terminal/JSON/Markdown/share rendering
- `src/update`
  Startup update check

## Core invariants

- deterministic ordering for periods, sources, candidates, and models
- source-specific parsing stays behind adapter contracts
- provider values are normalized to billing entities at the domain boundary
- diagnostics stay on `stderr`
- report bodies stay on `stdout`
- JSON/Markdown output remains data-only on `stdout`
- OpenCode parsing is read-only through built-in `node:sqlite`
- incomplete pricing is surfaced explicitly (`~$...`, warnings, or incomplete flags)
