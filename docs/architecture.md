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
  Owns the canonical registry for `summary` (the default command), `hourly`, `daily`, `weekly`, `monthly`, `projects`, `compare`, `efficiency`, `optimize`, `trends`, `session`, `tools`, `context`, `blocks`, `value`, `wrapped`, `events`, `pricing`, `statusline`, `doctor`, and `prune`. (`config`, `schema`, `completion`, `machine`, and `sync` are registered directly in `create-cli.ts`; `create-completion-command.ts` generates the bash, zsh, and fish scripts from the live command tree.)
- `src/cli/report-definitions/shared-report-options.ts`
  Registers the shared option surface by profile (`usage`, `hourly`, `rollup`, `pricing`, `summary`, `specialized`, `compare`, `trends`, `session`, `tools`, `wrapped`, `events`, `statusline`, `doctor`, `config`).

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
  - `--share`, `--no-open` and `--redact` validation, and the share artifact the report wrapper builds: `cli/share-report-artifact.ts` builds the payload (`cli/build-share-report-data.ts`) and the self-contained HTML (`share-report/render-share-html.ts`), and `cli/share-artifact.ts` writes the file and opens it
  - optional terminal overflow warnings
  - stderr hints after the output (from the data, or from the renderer, such as columns a narrow terminal hid)
  - final stdout emission

Each report wrapper owns its policy:

- data builder
- renderer
- report-specific diagnostics
- share eligibility rules

Each command has a `run*` entry point, and most have a `build*` that returns the output as a string for tests:

- `buildSummaryReport`, `runSummaryReport`
- `buildUsageReport`, `runUsageReport` (daily, weekly, monthly and hourly; `runHourlyReport` calls `runUsageReport('hourly', …)`)
- `buildProjectsReport`, `runProjectsReport`
- `buildCompareReport`, `runCompareReport`
- `buildEfficiencyReport`, `runEfficiencyReport`
- `buildOptimizeReport`, `runOptimizeReport`
- `buildTrendsReport`, `runTrendsReport`
- `buildSessionReport`, `runSessionReport`
- `buildBlocksReport`, `runBlocksReport`
- `buildValueReportOutput`, `runValueReport`
- `buildWrappedReport`, `runWrappedReport`
- `buildPricingReport`, `runPricingReport`
- `buildStatusline`, `runStatusline`
- `buildDoctorResults`, `runDoctorReport`
- `buildPruneReport`, `runPruneReport`
- `runEventsReport`

## Runtime flows

### Usage

`runUsageReport(granularity, options)`

1. `buildUsageData(...)`
2. `aggregateUsage(..., { includeModelBreakdown: true })`
3. `renderUsageReportWithNotes(...)`
4. shared report runtime emits diagnostics, optional share report, and stdout body

### Projects

`runProjectsReport(options)`

1. `buildUsageEventDataset(...)` and pricing
2. `aggregateProjects(...)` (`src/cli/build-projects-data.ts`): per-project totals keyed by `toProjectKey` and labelled by `buildEventProjectLabels` (`src/aggregate/project-key.ts`), which keeps folders with the same name apart and labels events with no repository `(unattributed)`
3. `renderProjectsReport(...)`
4. shared report runtime emits diagnostics and stdout body

### Blocks

`runBlocksReport(options)`

1. `readBlocksDataset(...)` (`src/cli/build-blocks-data.ts`, shared with `--share`): `buildUsageEventDataset(...)` with a `lookbackSince` a week before the window, so a block that started earlier keeps its start while filters resolve over the window, then pricing
2. `readWholeStreams(...)` when `--repo`, `--model`, `--provider` or `--machine` narrowed the events: each source's whole stream over the same dates, so blocks keep the account's 5-hour windows; `--machine` reads every machine's cached usage again for this
3. `aggregateBlocks(...)` (`src/blocks`) places the windows on the whole stream and counts the narrowed events in them
4. `renderBlocksReport(...)`, with the active block's burn rate
5. shared report runtime emits diagnostics and stdout body

### Value

`runValueReport(options)`

1. `selectPlans(...)` and `resolvePlanScopes(...)` (`src/value/plans.ts`) pick the plans and the sources each covers; the default plan falls back to one whose sources the `--source` filter keeps
2. `buildUsageEventDataset(...)` over the plans' sources, and pricing
3. `buildValueReport(...)` (`src/value/build-value-report.ts`): API-priced cost per month against each plan's price, split by project
4. `renderValueReport(...)`
5. shared report runtime emits diagnostics and stdout body

### Pricing

`runPricingReport(models, options)` loads the pricing source like a report does and runs `explainModelPricing(...)` (`src/pricing/explain-model-pricing.ts`) for each model name: the matched key and rule, overrides, where the prices came from, rates and tiers. It never reads usage.

### Efficiency

`runEfficiencyReport(granularity, options)`

1. `buildUsageData(...)`
2. repo attribution (`src/efficiency/repo-attribution.ts`)
3. Git outcomes (`src/efficiency/git-outcome-collector.ts`)
4. `aggregateUsage(..., { includeModelBreakdown: false })`
5. `aggregateEfficiency(...)`
6. `renderEfficiencyReport(...)`
7. shared report runtime emits diagnostics, optional share report, and stdout body

### Optimize

`runOptimizeReport(granularity, options)`

1. `buildUsageEventDataset(...)`
2. pricing load and application
3. `aggregateUsage(..., { includeModelBreakdown: false })`
4. `buildCounterfactualRows(...)`
5. `renderOptimizeReport(...)`
6. shared report runtime emits diagnostics, optional share report, and stdout body

### Trends

`runTrendsReport(options)`

1. `buildUsageEventDataset(...)`
2. optional pricing load (cost mode only)
3. `aggregateUsage(..., { granularity: 'daily', includeModelBreakdown: false })`
4. `aggregateTrends(...)`; in cost mode the fetch starts 28 days before the chart so `findSpendSpikes(...)` can mark spike days with `spike: true`
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
2. per-session grouping (or per-project with `--by-repo`) with a top-N row limit (`src/session`)
3. with `--id <id> --timeline`: exactly one session must match; `readLiveSessionEvents(...)` reads its tool calls and messages for the files that hold its usage, departed files history served included, `dedupeToolCalls` counts copied calls once, and `buildSessionTimeline(...)` interleaves them with the session's priced requests and a running cost
4. `renderSessionReport(...)`
5. shared report runtime emits diagnostics and stdout body

### Tools

`runToolsReport(options)`

1. `buildToolsData(...)` resolves the window as `daily` does (last 7 days by default) and builds the usage dataset as reports do, history and other machines included; it loads no prices
2. `readLiveSessionEvents(...)` (`src/cli/read-live-session-events.ts`) reads `tool_call` events of those files and of the departed files history served from the event store (`readStoredSessionEvents`), or from the files on disk through core `readEvents` with the store off or for a file it could not store, then reads the other machines' calls from their caches and drops those this machine or an earlier machine already counts (`mergeMachineSessionEvents`, the same per-session merge as usage), and `dedupeToolCalls` counts a call copied into a resumed or forked session once
3. `aggregateTools(...)` (`src/tools`): calls, errors, unknown results, sessions and top project per tool, split by source or project on request
4. `renderToolsReport(...)`
5. shared report runtime emits diagnostics, the note on where tool calls came from, and stdout body

### Context

`runContextReport(options)`

1. `buildContextData(...)` resolves the window as `daily` does and builds the usage dataset
2. pricing is loaded whenever an event names a model, since the report needs tier rates and context limits (`getMaxInputTokens`), not event costs
3. `aggregateContextPressure(...)` (`src/context`): per model or per session, peak prompt, requests above 200k tokens, the long-context tier extra from the cost engine's `estimateLongContextExtraUsd`, and requests above 80% of the context limit; events without `singleRequest` are counted per source as aggregated
4. `renderContextReport(...)`
5. shared report runtime emits diagnostics and stdout body

### Wrapped

`runWrappedReport(options)`

1. `buildWrappedData(...)` builds the priced dataset for the recap year's range
2. `aggregateWrapped(...)` (`src/wrapped`)
3. `renderWrappedReport(...)`
4. shared report runtime emits diagnostics, optional share report, and stdout body

### Summary

`runSummaryReport(options)`

1. `buildSummaryData(...)` builds one priced dataset from a year before today through today (the range the activity grid needs)
2. per-window totals for today, the last 7 days, and month to date, split by source, and by machine when other machines' events are present
3. `resolveMonthEnd(...)` projects the month-end cost from the 3rd of the month on, and compares it with `monthlyBudgetUsd` unless `--source`, `--model`, or `--provider` narrows the run
4. `estimateCacheSavingsUsd(...)` for month to date, and `aggregateDailyActivity(...)` for streaks and the heatmap
5. `findSpendSpikes(...)` (`src/aggregate/spend-spikes.ts`) over the last 7 days, and `findSpikeDrivers(...)` for the costliest spike's top project and model
6. shared report runtime emits diagnostics and stdout body

### Statusline

`runStatusline` builds the summary data with offline pricing and machine sync off, so it never fetches prices or opens an ssh connection and skips the update check, and prints one line from it with the logger silenced unless `--verbose`. Under Claude Code it also reads the session JSON from stdin and puts the session cost and context use first. It parses on the same worker pool as every other command: with `parseWorkers` at `auto`, at most six threads while it writes the event store.

### Machines and Sync

`machine add` and `sync` run `syncMachine` (`src/machines/sync-machine.ts`): it runs `llm-usage machine export` on the other machine over ssh, sends the files its cache already holds so only changed files come back (`--full` asks for all of them), and applies the bundle to that machine's cache in one transaction. A failed sync leaves the cache as it was and records the error.

Reports refresh caches themselves: `buildUsageEventDataset` calls `refreshDueMachines` alongside the local parse, which syncs each enabled machine whose last sync or attempt is at least 10 minutes old and waits at most 30 seconds before using what is cached. `--no-sync` and `statusline` skip the refresh.

### Config show

`config show` runs `buildConfigReport(...)` (`src/cli/build-config-report.ts`): it resolves each setting with its origin (flag, env var, config or default), `stat`s source paths, opens the event store read-only, reads the pricing cache without fetching, and lists machines from the config without ssh.

### Doctor and Prune

Non-report commands with their own runners: `buildDoctorResults(...)` checks source discovery health and runtime configuration and `runDoctorReport` renders it; `buildPruneReport(...)` classifies departed event-store files through the shared history logic and `renderPruneReport` prints candidates and the apply summary.

### Event Store History

`src/persistence/event-store.ts` re-exports the store API. The code lives in
`event-store-schema.ts` (schema and migrations), `event-store-administration.ts`
(open, per-file ingest, reads, prune and vacuum), and `event-store-codec.ts`
(stored-event revalidation and content hashes). The store is a local ledger: schema changes run
as migrations, and unknown newer schemas disable store use instead of rebuilding
tables.

`src/persistence/event-store-history.ts` owns `--history` reads. It compares the
current run's discovered `(source, file_path)` pairs with stored files, serves
departed files for selected sources, and suppresses moved or copied files by
content hash. A departed file that only partly overlaps counted events is served
without the overlapping events. The `override_only_files` table lists stored files
that only runs with a directory flag (`--claude-dir`, `--source-dir`) have discovered:
the first store write of a file in such a run adds it, and a run on the usual
directories removes the files it discovers. A run on the usual directories passes the
listed files as present, so they never become its history; prune still sees them as
departed and deletes their rows. Only files first stored after the table existed are
listed, and a file first read through a flag that points inside the usual location stays
listed until a run on the usual directories discovers it. Served history events are appended before the normal
provider/model/date filters, pricing, and aggregation steps, so downstream
report shapes stay unchanged.

`machine export` reuses that run: the dataset reports the stored files it counted
(successfully parsed files plus served history), and `readStoredFileSnapshots` reads
them back in one read transaction with a revision per file (a digest of its events, and
of its tool calls and messages when it has any), so another machine can sync only the files that changed. History files are read after
the parsed files and, as in history, without the events those files already hold, as
are the files of a source whose files repeat events (`eventsRepeatAcrossFiles`, pi);
deciding that on the same read transaction keeps a concurrent run from skewing it.

Reports read other machines after history and before the provider, model and date
filters: `buildUsageEventDataset` selects machines (`--machine`, or every configured one
unless the run points at custom source directories), reads each cache read-only within
the date window, and `mergeMachineEvents` leaves out events already counted, by content
hash, only for sessions present on both sides. The events then join the per-source
results, so pricing and aggregation treat them like local ones.

### Share reports

With `--share`, the report wrapper's share builder runs after the report's own data. `buildShareReportData` (`src/cli/build-share-report-data.ts`) reads the events a second time over the command's window, starting earlier so 5-hour blocks are whole, and builds the payload in `src/share-report/build-share-payload.ts`: a cube of totals by date, hour, source, model, project and machine, the sessions, the blocks, and the command's own JSON envelope. `redact.ts` and `sanitize-envelope.ts` label projects and machines (`--redact`) and scrub home paths. `render-share-html.ts` writes one HTML file that inlines the payload and the client bundle (`src/share-report/client`, prebuilt into `client-bundle.generated.ts` by `scripts/build-share-client.mjs`) under a CSP that allows only those hashed inline bytes. The client computes every roll-up in the browser.

## Aggregation profiles

`src/aggregate/aggregate-usage.ts` supports `includeModelBreakdown`.

- usage reports keep model breakdowns
- efficiency, optimize, trends, and the compare and summary windows skip model breakdown computation

This removes unnecessary work and avoids leaking usage-table-specific model metadata into reports that do not need it.

## Generic table rendering

`src/render/unicode-table.ts` is driven by explicit table row metadata:

- `periodKey`
- `rowKind` (`detail`, `combined`, `total`)

That keeps sorting and separator behavior deterministic without coupling the generic table renderer to `UsageReportRow`. A rule separates period groups and sets off the `total` row; rows of one group (and every row of a flat list) share it. Every cell starts on its row's first line.

With a terminal width, a caller's `fit` (abbreviated body rows and an ordered list of hideable columns) gives the table its fit ladder: the full table, then abbreviated values, then those values with one more hideable column left out per step. The first step that fits is boxed. Only when the last step is too wide are rows listed as label/value lines, with every column in full detail; a title cell the table wrapped is taken from its measure cell, so callers pass that text unwrapped. The usage table (`terminal-table.ts`) runs its own steps through the same `findFittingStep` loop.

## Module map

- `src/cli`
  Command creation, shared runtime, builders, diagnostics emission; the installed bin is `bin.ts` (built to `dist/bin.js`), a tiny loader that enables Node's compile cache and then imports the bundled CLI in `dist/index.js`, which parse workers also load; `parse-worker-pool.ts` holds the worker-thread parse pool; `parse/` groups the parse-pipeline concerns (`event-store-parse-cache.ts` store read/write caching, `since-file-skip.ts` the `--since` mtime cutoff, `parse-budget.ts` the global parse semaphore, `usage-event-filters.ts` provider/date/model filtering) around the coordinator in `build-usage-data-parsing.ts`, which takes dependency fingerprints from core's `getFileFingerprint`; `usage-window-summary.ts` sums date windows for `compare` and `summary`
- `src/cli/report-definitions`
  Canonical report metadata and option profiles
- `src/cli/report-runtime`
  Shared report execution lifecycle
- `src/config`
  TOML config loading (`user-config.ts`) and flag/env/config/default resolution (`runtime-overrides.ts`)
- `packages/core/src/sources`
  Source adapters, discovery, parsing, in the `@ayagmar/agent-sessions` package; the CLI imports them through the package specifiers. Each adapter's `read(filePath, options)` yields a file's events as an async iterable; the CLI parse path, the parse worker and `doctor` read whole files through `collectFile`, except that the parse reads a file it will store through `collectFileForEventStore` (`src/cli/parse/stored-session-events.ts`) when its adapter declares tool calls or messages. `capabilities.kinds` lists the event kinds an adapter produces: claude, codex and pi also implement `readEvents(filePath, options)`, which yields usage records, messages, tool calls and session facts (`SessionEvent` in `packages/core/src/domain/session-event.ts`); every other adapter declares `['usage']`. With the event store on, the parse path reads such a file once through `readEvents` for usage, tool calls and messages, and stores all three, with the read cursor of claude and pi files (qwen, usage only, keeps one too): a later run that finds such a file only grown resumes from the cursor and appends the new rows (`readFileGrowth` in `src/cli/parse/event-store-parse-cache.ts`, `src/persistence/event-store-append.ts`); its usage events and skipped rows are what `read` gives (the readEvents contract). `tools`, `session --timeline` and `session --json` read tool calls and messages from the store in `src/cli/read-live-session-events.ts`, and through `readEvents` from disk with the store off
- `packages/core/src/stream`
  `collect`/`collectFile` (an async iterable to an array, a file to its events and sorted skipped-row counts), `readEvents` (an adapter's `readEvents`, or its `read` events as usage records when it has none), the `kinds()`, `since()`, `until()` and `bySession()` stages, the JSONL read cursor (`cursor.ts`), and `pipe` with the `Stage` type that the dedup stage forms (`repeatedAcrossFiles`, `copiedSessions` in `packages/core/src/dedup`, which dedupe usage and pass other kinds through) plug into; `dedupeToolCalls` keeps one tool call per source and call id
- `packages/core/src/registry`
  The adapter registry (`createDefaultAdapters`, `getDefaultSourceIds`) and `readSources`, which reads and dedupes whole sources for library users (the CLI does not use it), exported as `@ayagmar/agent-sessions/registry`; `src/sources/create-default-adapters.ts` re-exports it for the docs site
- `src/domain`
  The CLI's usage event and report row contracts
- `src/pricing`
  LiteLLM pricing loader, cache, model matching, cost engine, long-context tiers, and `explain-model-pricing.ts` for the `pricing` command
- `src/persistence`
  SQLite event-store ledger, schema migrations, history suppression
- `src/machines`
  Multi-machine sync: the versioned `machine export` bundle format and its validating reader (`machine-export-bundle.ts`), the ssh transport and `command` detection (`machine-ssh.ts`), per-machine caches (`machine-cache.ts`, each an event store under `machines/<name>.db`), `sync` (`sync-machine.ts`), safe `config.toml` edits for `machine add/remove` (`machine-config-file.ts`), and the report-side read and cross-machine dedup (`load-machine-usage.ts`, `merge-machine-events.ts`)
- `src/aggregate`
  Period/source usage aggregation, split by project with `--by-repo` (the projects past `--top` folded per source); `project-key.ts` holds the project keys and labels that every report naming projects, the share report and `--repo` use; `daily-activity.ts` holds the streak, best-day, and heatmap-level logic shared by `summary` and `wrapped`; `spend-spikes.ts` finds the spend spike days that `summary` and `trends` note
- `src/blocks`
  Estimated 5-hour usage blocks per source
- `src/value`
  Subscription plan prices and the per-month value comparison
- `src/efficiency`
  Repo attribution, Git outcomes, efficiency aggregation
- `src/optimize`
  Counterfactual pricing aggregation
- `src/trends`
  Trend series contracts and daily trend aggregation
- `src/session`
  Per-conversation and per-project usage aggregation, and the `--timeline` rows of one session
- `src/tools`
  Tool-call counts per tool for the `tools` report
- `src/context`
  Peak prompt sizes, long-context requests and requests near the context limit for the `context` report
- `src/wrapped`
  Yearly recap aggregation
- `src/render`
  Terminal/JSON/Markdown rendering
- `src/share-report`
  The `--share` HTML report: payload building, redaction, the HTML document, and the bundled browser client in `client/`
- `src/otel-export`
  OTLP/JSON for `events --format otlp-traces` and `otlp-metrics`: the span tree per session, daily metric points per agent, derived ids, resource and attribute encoding
- `src/update`
  Startup update check
- `src/utils`
  Shared fs/discovery/time helpers and the leveled stderr logger (`logger.ts`)

## Core package surface

`@ayagmar/agent-sessions` (`packages/core`) has one entry per `exports` subpath, and `tsup.config.ts` derives its build entries from that map:

| Subpath          | Tier         | Holds                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`              | public       | event types and constructors, the adapter contract, `SourceContext`, stages, dedup, versions, cursor types                                                                                                                                                                                                                                      |
| `./registry`     | public       | `createDefaultAdapters`, `getDefaultSourceIds`, `getSourceStorageFormat`, `readSources`                                                                                                                                                                                                                                                         |
| `./sources/<id>` | public       | one adapter and its options type (roocode and kilocode export the cline family's `createClineFamilyAdapter` factory instead of a class), plus `resolveDefaultCodexSessionsDir` and `LEGACY_CODEX_MODEL_FALLBACK` on codex, `getDefaultDshSessionsDir` on dsh and `CLINE_EXTENSION_IDS` on the cline family; `public-surface.test.ts` lists them |
| `./otel`         | experimental | OpenTelemetry GenAI attribute helpers                                                                                                                                                                                                                                                                                                           |
| `./internal`     | unstable     | what only the CLI uses: provider normalization, terminal text, pricing predicates, fingerprints, utilities                                                                                                                                                                                                                                      |

Semver covers the public tiers, minus names tagged `@internal` (the parse-worker helpers on `./registry`, adapter test seams). The CLI imports `.`, `./registry` and `./internal`, some through `src/` shims that keep older import paths, and tsup bundles the core into `dist/index.js`. Importing `.` or `./internal` loads no source's code, and importing one `./sources/<id>` loads no other source's code, except that `roocode` and `kilocode` load `cline`, whose family adapter builds them. Tests in `packages/core/tests` pin this: `public-surface.test.ts` lists every exported name per subpath, `tsdoc-presence.test.ts` requires a doc comment on each public one, and `subpath-isolation.test.ts` checks module isolation in source and in `dist`.

## Deep dives

The published site documents the core subsystems in depth; keep the deep detail there and the file-level map here:

- [Event Store](https://ayagmar.github.io/llm-usage-metrics/architecture/event-store/)
- [Parse Pipeline](https://ayagmar.github.io/llm-usage-metrics/architecture/parse-pipeline/)
- [Pricing Pipeline](https://ayagmar.github.io/llm-usage-metrics/architecture/pricing-pipeline/)
- [Event Model](https://ayagmar.github.io/llm-usage-metrics/architecture/event-model/)
- [Dedup & Cursors](https://ayagmar.github.io/llm-usage-metrics/architecture/dedup-and-cursors/)
- [Machine Merge](https://ayagmar.github.io/llm-usage-metrics/architecture/machine-merge/)
- [Share Report](https://ayagmar.github.io/llm-usage-metrics/architecture/share-report/)
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
