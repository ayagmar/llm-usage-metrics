# Idea #1: Local usage event store (SQLite)

> Status: **Shipped v2 on `feat/improvements` (2026-07)**. The shipped scope is
> a default-on SQLite event-store ledger with per-file reuse and `--history`
> reports for departed source files.

## What shipped

`llm-usage` now keeps a local SQLite database at
`<platform-cache-root>/llm-usage-metrics/events.db` by default. Each discovered
source file is tracked by `(source, file_path)` plus the same dependency
fingerprint used by the parser:

- the primary file size and mtime;
- adapter-declared sidecar inputs, such as config or sibling metadata files;
- missing sidecar inputs, which are part of the fingerprint.

When the fingerprint matches, the CLI reads normalized `UsageEvent` rows and
stored parse diagnostics from SQLite instead of reparsing the file. When the
fingerprint changes, the file is parsed normally and the store atomically
replaces that file's rows. The store also keeps rows for files that are no
longer discovered.

`--history` reports include departed-file usage for the selected sources. Moved,
renamed, and copied files are suppressed by content hash so the departed copy is
not double counted; provider/model/date filters, pricing, and aggregation stay
in the normal reporting pipeline.

The store is enabled by default. Set `LLM_USAGE_EVENT_STORE=0` for a cold parse
run, or `LLM_USAGE_EVENT_STORE_PATH=/path/to/events.db` to isolate a store for
testing or benchmarking.

## Current boundaries

- default reports still reflect currently discovered source files unless
  `--history` is set;
- bucketing, pricing, filters, and aggregation still happen in the existing
  report pipeline;
- no source data is fetched from the network;
- deleting `events.db` deletes retained local history and starts a new ledger on
  the next run.

This design preserves byte-identical default report output between disabled,
cold, and warm store runs while making repeat runs faster when source files are
unchanged. History quality depends on how long the store has been running.

## Follow-up work — since shipped

All three follow-ups considered at the time this idea was written have since
shipped:

- prune/compaction tooling for intentionally deleting old retained
  history — shipped as the `prune` command (plan 038);
- prepared-statement reuse for event-store queries — shipped (plans 045/052),
  see `store.statements.getFileEntry` in `src/persistence/event-store.ts`;
- a `compare` command for month-over-month or period-over-period deltas on top
  of the ledger — shipped (plan 033).
