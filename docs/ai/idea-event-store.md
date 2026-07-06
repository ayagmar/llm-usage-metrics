# Idea #1: Local usage event store (SQLite)

> Status: **Shipped v1 on `feat/improvements` (2026-07)**. The shipped scope is
> a default-on per-file SQLite event store used to skip unchanged file parsing.
> History/retention/query-ledger work is parked as v2.

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
replaces that file's rows.

The store is enabled by default. Set `LLM_USAGE_EVENT_STORE=0` for a cold parse
run, or `LLM_USAGE_EVENT_STORE_PATH=/path/to/events.db` to isolate a store for
testing or benchmarking.

## Current boundaries

The v1 store is intentionally a parse accelerator, not a historical reporting
ledger:

- reports still reflect the currently discovered source files;
- deleted-file rows may remain in SQLite, but they are not read unless the file
  is discovered again;
- bucketing, pricing, filters, and aggregation still happen in the existing
  report pipeline;
- no source data is fetched from the network;
- deleting `events.db` forces a full rebuild on the next run.

This design preserves byte-identical report output between disabled, cold, and
warm store runs while making repeat runs faster when source files are unchanged.

## Parked v2 work

The original larger idea was a queryable historical event ledger. That remains a
separate project because it needs product semantics the v1 accelerator avoids:

- retention and pruning rules for rows from deleted or moved files;
- deduplication semantics across file moves, source migrations, and rewritten
  transcripts;
- query APIs that can answer historical questions without first rediscovering
  current files;
- explicit rebuild/reset UX beyond deleting the SQLite file;
- storage-growth reporting in `doctor`.

Those should be designed against real use cases before adding a second read
path to the reporting layer.
