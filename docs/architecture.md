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
  Owns the canonical registry for `summary` (the default command), `daily`, `weekly`, `monthly`, `compare`, `efficiency`, `optimize`, `trends`, `session`, `wrapped`, `statusline`, `doctor`, `prune`, and `events`. (`config`, `schema`, `completion`, `machine`, and `sync` are registered directly in `create-cli.ts`; `create-completion-command.ts` generates the bash, zsh, and fish scripts from the live command tree.)
- `src/cli/report-definitions/shared-report-options.ts`
  Registers the shared option surface by profile (`usage`, `summary`, `specialized`, `compare`, `trends`, `session`, `wrapped`, `events`, `statusline`, `doctor`).

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
  - share artifact handling: render the card per theme, write the dark SVG and the HTML export page (`render/render-share-page.ts`), open the page
  - optional terminal overflow warnings
  - stderr hints after the output (from the data, or from the renderer, such as columns a narrow terminal hid)
  - final stdout emission

Each report wrapper owns its policy:

- data builder
- renderer
- report-specific diagnostics
- share eligibility rules

The public entry points remain stable, one `build*`/`run*` pair per command:

- `buildSummaryReport`, `runSummaryReport`
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
3. `renderUsageReportWithNotes(...)`
4. shared report runtime emits diagnostics, optional share card, and stdout body

### Efficiency

`runEfficiencyReport(granularity, options)`

1. `buildUsageData(...)`
2. repo attribution (`src/efficiency/repo-attribution.ts`)
3. Git outcomes (`src/efficiency/git-outcome-collector.ts`)
4. `aggregateUsage(..., { includeModelBreakdown: false })`
5. `aggregateEfficiency(...)`
6. `renderEfficiencyReport(...)`
7. shared report runtime emits diagnostics, optional share card, and stdout body

### Optimize

`runOptimizeReport(granularity, options)`

1. `buildUsageEventDataset(...)`
2. pricing load and application
3. `aggregateUsage(..., { includeModelBreakdown: false })`
4. `buildCounterfactualRows(...)`
5. `renderOptimizeReport(...)`
6. shared report runtime emits diagnostics, optional share card, and stdout body

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
4. shared report runtime emits diagnostics, optional share card, and stdout body

### Summary

`runSummaryReport(options)`

1. `buildSummaryData(...)` builds one priced dataset from a year before today through today (the range the activity grid needs)
2. per-window totals for today, the last 7 days, and month to date, split by source, and by machine when other machines' events are present
3. `resolveMonthEnd(...)` projects the month-end cost from the 3rd of the month on, and compares it with `monthlyBudgetUsd` unless `--source`, `--model`, or `--provider` narrows the run
4. `estimateCacheSavingsUsd(...)` for month to date, and `aggregateDailyActivity(...)` for streaks and the heatmap
5. shared report runtime emits diagnostics and stdout body

### Statusline

`runStatusline` builds the summary data with offline pricing and machine sync off, so it never fetches prices or opens an ssh connection and skips the update check, and prints one line from it with the logger silenced unless `--verbose`. Under Claude Code it also reads the session JSON from stdin and puts the session cost and context use first.

### Machines and Sync

`machine add` and `sync` run `syncMachine` (`src/machines/sync-machine.ts`): it runs `llm-usage machine export` on the other machine over ssh, sends the files its cache already holds so only changed files come back (`--full` asks for all of them), and applies the bundle to that machine's cache in one transaction. A failed sync leaves the cache as it was and records the error.

Reports refresh caches themselves: `buildUsageEventDataset` calls `refreshDueMachines` alongside the local parse, which syncs each enabled machine whose last sync or attempt is at least 10 minutes old and waits at most 30 seconds before using what is cached. `--no-sync` and `statusline` skip the refresh.

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
them back in one read transaction with a revision per file (a digest of its events),
so another machine can sync only the files that changed. History files are read after
the parsed files and, as in history, without the events those files already hold, as
are the files of a source whose files repeat events (`eventsRepeatAcrossFiles`, pi);
deciding that on the same read transaction keeps a concurrent run from skewing it.

Reports read other machines after history and before the provider, model and date
filters: `buildUsageEventDataset` selects machines (`--machine`, or every configured one
unless the run points at custom source directories), reads each cache read-only within
the date window, and `mergeMachineEvents` leaves out events already counted, by content
hash, only for sessions present on both sides. The events then join the per-source
results, so pricing and aggregation treat them like local ones.

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
  Command creation, shared runtime, builders, diagnostics emission; the installed bin is `bin.ts` (built to `dist/bin.js`), a tiny loader that enables Node's compile cache and then imports the bundled CLI in `dist/index.js`, which parse workers also load; `parse-worker-pool.ts` holds the worker-thread parse pool; `parse/` groups the parse-pipeline concerns (`parse-fingerprint.ts` dependency fingerprinting, `event-store-parse-cache.ts` store read/write caching, `since-file-skip.ts` the `--since` mtime cutoff, `parse-budget.ts` the global parse semaphore, `usage-event-filters.ts` provider/date/model filtering) around the coordinator in `build-usage-data-parsing.ts`; `usage-window-summary.ts` sums date windows for `compare` and `summary`
- `src/cli/report-definitions`
  Canonical report metadata and option profiles
- `src/cli/report-runtime`
  Shared report execution lifecycle
- `src/config`
  TOML config loading (`user-config.ts`) and flag/env/config/default resolution (`runtime-overrides.ts`)
- `packages/core/src/sources`
  Source adapters, discovery, parsing, in the `@ayagmar/agent-sessions` package; the CLI imports them through the package specifiers. Each adapter's `read(filePath, options)` yields a file's events as an async iterable; the CLI parse path, the parse worker and `doctor` read whole files through `collectFile`. `capabilities.kinds` lists the event kinds an adapter produces: claude, codex and pi also implement `readEvents(filePath, options)`, which yields usage records, messages, tool calls and session facts (`SessionEvent` in `packages/core/src/domain/session-event.ts`); every other adapter declares `['usage']`. The CLI uses only `read`, whose output `readEvents` leaves unchanged
- `packages/core/src/stream`
  `collect`/`collectFile` (an async iterable to an array, a file to its events and sorted skipped-row counts), `readEvents` (an adapter's `readEvents`, or its `read` events as usage records when it has none), the `kinds()`, `since()`, `until()` and `bySession()` stages, the JSONL read cursor (`cursor.ts`), and `pipe` with the `Stage` type that the dedup stage forms (`repeatedAcrossFiles`, `copiedSessions` in `packages/core/src/dedup`, which dedupe usage and pass other kinds through) plug into
- `packages/core/src/registry`
  The adapter registry (`createDefaultAdapters`, `getDefaultSourceIds`) and `readSources`, which reads and dedupes whole sources for library users (the CLI does not use it), exported as `@ayagmar/agent-sessions/registry`; `src/sources/create-default-adapters.ts` re-exports it for the docs site
- `src/domain`
  Canonical usage contracts and normalization
- `src/pricing`
  LiteLLM pricing loader, cache, model matching, cost engine
- `src/persistence`
  SQLite event-store ledger, schema migrations, history suppression
- `src/machines`
  Multi-machine sync: the versioned `machine export` bundle format and its validating reader (`machine-export-bundle.ts`), the ssh transport and `command` detection (`machine-ssh.ts`), per-machine caches (`machine-cache.ts`, each an event store under `machines/<name>.db`), `sync` (`sync-machine.ts`), safe `config.toml` edits for `machine add/remove` (`machine-config-file.ts`), and the report-side read and cross-machine dedup (`load-machine-usage.ts`, `merge-machine-events.ts`)
- `src/aggregate`
  Period/source usage aggregation; `daily-activity.ts` holds the streak, best-day, and heatmap-level logic shared by `summary` and `wrapped`
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
