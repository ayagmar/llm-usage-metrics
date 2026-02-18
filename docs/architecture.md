# Architecture

## High-level flow

The runtime pipeline is linear and intentionally simple:

1. **CLI bootstrap** (`src/cli/index.ts`)
2. **Startup update check** (`src/update`)
3. **CLI command parsing** (`src/cli/create-cli.ts`)
4. **Source discovery + parsing** (`src/sources`)
5. **Event normalization** (`src/domain`)
6. **Pricing resolution** (`src/pricing`)
7. **Aggregation by period/source** (`src/aggregate`)
8. **Rendering** (`src/render`)

```mermaid
flowchart LR
    A[CLI entrypoint] --> B[Update notifier]
    B --> C[Command parser]
    C --> D[Source adapters]
    D --> E[Normalized usage events]
    E --> F[Pricing engine]
    F --> G[Aggregated rows]
    G --> H[Renderer]
    H --> I[Terminal / Markdown / JSON]
```

## Runtime sequence

```mermaid
sequenceDiagram
    participant User
    participant Entry as CLI entrypoint
    participant UP as Update notifier
    participant CLI as CLI (run-usage-report)
    participant PI as PiSourceAdapter
    participant CX as CodexSourceAdapter
    participant PR as PricingSource
    participant AG as Aggregator
    participant RD as Renderer

    User->>Entry: llm-usage daily --markdown
    Entry->>UP: checkForUpdatesAndMaybeRestart()
    UP-->>Entry: continueExecution=true
    Entry->>CLI: parse command + run report
    CLI->>PI: discoverFiles + parseFile
    CLI->>CX: discoverFiles + parseFile
    PI-->>CLI: UsageEvent[]
    CX-->>CLI: UsageEvent[]
    CLI->>PR: load + getPricing(model)
    CLI->>AG: aggregateUsage(events)
    AG-->>CLI: UsageReportRow[]
    CLI->>RD: renderMarkdownTable(rows)
    RD-->>User: markdown output
```

## Update notifier flow

```mermaid
flowchart TD
    A[Startup] --> B{skip env / help / version / npx?}
    B -- yes --> C[Continue CLI]
    B -- no --> D[Resolve cached latest version]
    D --> E{Update available?}
    E -- no --> C
    E -- yes --> F{Interactive TTY?}
    F -- no --> G[Print one-line notice]
    G --> C
    F -- yes --> H{Install now?}
    H -- no --> C
    H -- yes --> I[npm install -g package@latest]
    I --> J{Install succeeded?}
    J -- no --> K[Print install failure]
    K --> C
    J -- yes --> L[Restart with skip env var]
```

## Module layout

### `src/cli`

- `create-cli.ts`: declares commands and flags.
- `run-usage-report.ts`: orchestrates end-to-end report generation.
- `package-metadata.ts`: resolves package metadata robustly across runtime layouts.
- `index.ts`: executable entrypoint.

### `src/sources`

- `source-adapter.ts`: adapter contract used by all sources.
- `pi/pi-source-adapter.ts`: parser for `.pi` sessions.
- `codex/codex-source-adapter.ts`: parser for `.codex` sessions.

### `src/domain`

- `usage-event.ts`: canonical event type and constructor.
- `usage-report-row.ts`: output row types.
- `normalization.ts`: shared normalization helpers.

### `src/config`

- `runtime-overrides.ts`: environment-variable runtime knobs with bounds and defaults.

### `src/pricing`

- `types.ts`: pricing interfaces.
- `cost-engine.ts`: cost estimation logic.
- `static-pricing-source.ts`: default local pricing fallback.
- `litellm-pricing-fetcher.ts`: remote pricing loader with cache/offline support.

### `src/update`

- `update-notifier.ts`: startup update check, npm registry lookup/cache, optional install and restart.

### `src/aggregate`

- `aggregate-usage.ts`: period bucketing + totals.

### `src/render`

- `row-cells.ts`: shared table cells/formatting.
- `terminal-table.ts`: default terminal output.
- `markdown-table.ts`: markdown output.

### `src/utils`

- `time-buckets.ts`: timezone-aware daily/weekly/monthly keys.
- `discover-jsonl-files.ts`: recursive sorted file discovery.
- `read-jsonl-objects.ts`: streaming JSONL reader used by adapters.

## Core data model

### Usage event

A parsed log line is converted into a `UsageEvent` with normalized numeric fields.

Important guarantees:

- token fields are non-negative integers
- timestamp is valid ISO string
- `costMode` is either `explicit` or `estimated`

### Report rows

Aggregation produces rows in this order:

1. one row per period/source (`pi`, `codex`, or future sources)
2. one period combined row when there are multiple sources in that period
3. one grand total row (`periodKey = ALL`)

## Design choices

### Source adapter pattern

Each source implements the same contract:

- discover files
- parse one file into normalized events

This keeps format-specific logic isolated and makes new sources straightforward to add.

Built-in adapters are `pi` and `codex`, but the contract already supports other source ids. Adding Claude/Gemini (or any other source) mainly requires a new adapter plus wiring it into the report pipeline.

### Pricing as a separate stage

Parsing does not depend on pricing. Parsing produces usage events first; pricing is applied later. This separation keeps parsing deterministic and easier to test.

### Deterministic output

Sorting rules are explicit:

- periods are sorted ascending
- sources are sorted with `pi` then `codex` then lexical fallback
- model names are deduplicated and sorted

### Failure tolerance

Malformed lines are ignored in adapters instead of stopping the entire report. This is deliberate: one bad session line should not block all usage reporting.

Update checks are also fail-open: any cache/network/install-check error falls back to normal CLI execution.
