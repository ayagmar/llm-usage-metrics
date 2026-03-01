# Architecture

## High-level design

`llm-usage-metrics` is built as a deterministic reporting pipeline with explicit boundaries:

1. **CLI orchestration** parses user intent.
2. **Source adapters** discover and parse source-native data.
3. **Domain normalization** enforces canonical event contracts.
4. **Pricing** resolves explicit/estimated cost values.
5. **Aggregation** buckets events by period and source.
6. **Rendering** formats rows for terminal/markdown/json.
7. **Diagnostics emission** reports operational context on `stderr`.

This keeps source-specific complexity isolated and report output deterministic.

`efficiency` reports reuse the usage pipeline, attribute usage events to a repository root, then join repo-scoped usage totals with local Git outcome totals.
`optimize` reports reuse the same usage parsing/filtering pipeline, then compute counterfactual candidate-model pricing over observed token totals.

## Runtime flow (flowchart)

```mermaid
flowchart LR
    A[CLI entrypoint\nsrc/cli/index.ts] --> B[Update notifier\nsrc/update]
    B --> C[Command parser\nsrc/cli/create-cli.ts]
    C --> D[runUsageReport]
    D --> E[buildUsageData]
    C --> O[runEfficiencyReport]
    C --> T[runOptimizeReport]
    O --> E
    T --> E
    O --> P[collectGitOutcomes]
    O --> S[attributeUsageEventsToRepo]
    E --> S
    P --> Q[aggregateEfficiency]
    S --> Q
    Q --> R[renderEfficiencyReport]
    R --> L

    E --> F[Source adapters\npi/codex/gemini/droid/copilot-cli/copilot-vscode/opencode]
    F --> G[UsageEvent list]
    G --> H[Pricing resolver\nLiteLLM cache/network]
    H --> I[Aggregator\nperiod/source totals]
    I --> J[UsageDataResult]
    J --> U[Counterfactual engine\ncandidate ranking + deltas]
    U --> V[renderOptimizeReport]
    V --> L

    J --> K[renderUsageReport]
    K --> L[stdout report body]

    D --> M[emitDiagnostics]
    M --> N[stderr diagnostics]
    O --> M
    T --> M
```

## End-to-end sequence

```mermaid
sequenceDiagram
    participant User
    participant Entry as CLI entrypoint
    participant Update as Update notifier
    participant Run as CommandRunner
    participant Build as buildUsageData
    participant Adapter as Source adapters
    participant Pricing as Pricing resolver
    participant Agg as Aggregator
    participant Render as renderUsageReport
    participant Emit as emitDiagnostics
    participant Git as collectGitOutcomes
    participant Cfx as counterfactual engine

    User->>Entry: llm-usage monthly --source pi,codex
    Entry->>Update: checkForUpdatesAndMaybeRestart()
    Update-->>Entry: continueExecution=true
    Entry->>Run: execute command
    Run->>Build: buildUsageData(granularity, options)
    Build->>Adapter: discoverFiles() + parseFile()
    Adapter-->>Build: UsageEvent list
    Build->>Pricing: resolvePricingSource(...)
    Pricing-->>Build: pricing source + origin
    Build->>Agg: aggregateUsage(events)
    Agg-->>Build: UsageReportRow list
    Build-->>Run: UsageDataResult
    Run->>Render: renderUsageReport(data, format)
    Render-->>Run: report string
    Run->>Emit: emitDiagnostics(data.diagnostics)
    Run-->>User: stderr diagnostics + stdout report

    User->>Entry: llm-usage efficiency weekly --repo-dir /repo
    Entry->>Run: runEfficiencyReport(...)
    Run->>Build: buildUsageData(...)
    Run->>Git: collectGitOutcomes(...)
    Build-->>Run: usage events + rows + diagnostics
    Git-->>Run: outcome totals
    Run->>Run: attribute usage events to repo root
    Run->>Run: aggregateEfficiency(...)
    Run->>Render: renderEfficiencyReport(data, format)
    Render-->>Run: report string
    Run->>Emit: emitDiagnostics(data.diagnostics.usage)
    Run-->>User: stderr diagnostics + stdout efficiency report

    User->>Entry: llm-usage optimize monthly --candidate-model gpt-4.1
    Entry->>Run: runOptimizeReport(...)
    Run->>Build: buildUsageData(...)
    Build-->>Run: usage events + rows + diagnostics
    Run->>Cfx: evaluate candidate pricing on baseline token totals
    Cfx-->>Run: baseline + candidate rows
    Run->>Run: renderOptimizeReport(data, format)
    Run->>Emit: emitDiagnostics(data.diagnostics.usage)
    Run-->>User: stderr diagnostics + stdout optimize report
```

## Module map

- `src/cli`: command creation, validation, orchestration, diagnostics contracts
- `src/sources`: adapter contract + source-specific parsers
- `src/domain`: normalized contracts and constructors
- `src/pricing`: LiteLLM loader/cache + cost engine
- `src/aggregate`: daily/weekly/monthly bucketing and totals
- `src/render`: terminal/markdown/json formatting
- `src/efficiency`: git-outcome collection and efficiency aggregation
- `src/optimize`: counterfactual candidate-model computation and row contracts
- `src/update`: startup update check

## Core invariants

- deterministic ordering (period/source/model)
- source parsing isolated behind adapter contract
- provider values are normalized to billing-entity identifiers at domain boundaries
- diagnostics on `stderr`, report data on `stdout`
- OpenCode runtime parsing is read-only (`node:sqlite`)
- unresolved cost values are surfaced explicitly (`-` / `~$...` semantics)
