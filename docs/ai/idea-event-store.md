# Idea #1: Local usage event store (SQLite)

> Confidence: **80%** — highest strategic payoff, largest effort. Not started.

## The problem this solves

Every `llm-usage` run is **stateless**: it re-discovers every source directory,
re-parses every JSONL/DB row, re-prices every event, then throws it all away.
For a user with months of Claude/pi/codex history this is hundreds of MB of
repeated work on each invocation. The parse-file cache mitigates this per-file,
but it is keyed on file fingerprints and TTLs, not on a queryable dataset.

Consequences:

- **Trends and historical comparison recompute from scratch every run.** There
  is no way to ask "how did this month compare to last month" without re-parsing
  both months.
- **No cross-run deduplication.** A source file that grew (new session appended)
  triggers a full re-parse of that file, not an incremental append.
- **No cheap aggregations.** "Total tokens across all time, by source" requires
  re-parsing all time, every time.

## The idea

Introduce a single local SQLite database (`<cache-root>/llm-usage-metrics/events.db`)
that stores **normalized `UsageEvent` rows** keyed by a stable content hash.
Discovery + parsing become an **ingestion step** that writes new/updated rows;
reports become **queries** against the store.

### Schema (sketch)

```sql
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash  TEXT NOT NULL UNIQUE,   -- hash of (source, sessionId, timestamp, model, token buckets)
  source        TEXT NOT NULL,
  session_id    TEXT,
  timestamp     TEXT NOT NULL,           -- ISO 8601, bucketed via the existing timezone logic at query time
  model         TEXT,
  provider      TEXT,
  repo_root     TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL,
  cost_mode    TEXT NOT NULL,            -- 'estimated' | 'explicit'
  ingested_at  INTEGER NOT NULL
);
CREATE INDEX events_source_ts ON events(source, timestamp);
CREATE INDEX events_model_ts  ON events(model, timestamp);
```

### Ingestion flow

```ts
// src/persistence/event-store.ts (new layer)
export interface EventStore {
  ingest(source: string, events: UsageEvent[]): Promise<{ inserted: number; updated: number }>;
  query(range: DateRange, filters: EventFilters): Promise<UsageEvent[]>;
}
```

- `ingest` computes `content_hash` per event and does `INSERT ... ON CONFLICT(content_hash) DO NOTHING`.
  This makes ingestion **idempotent**: re-running over the same files is a no-op.
- A `source_files` table tracks `(source, file_path, fingerprint, ingested_at)` so
  ingestion can skip files whose fingerprint is unchanged (same idea as the current
  parse-file cache, but persistent and queryable).

### Report path change

`buildUsageEventDataset` gains an ingestion seam: after parsing, it calls
`eventStore.ingest(...)`, then reads from the store (or, for a cold run with no
store, falls back to the in-memory path). Pricing is applied at query time from
the pricing source, exactly as today.

## Why it is a good improvement

- **Repeat runs become near-instant** when nothing changed (a `SELECT` instead of
  a full re-parse). This is the single biggest perceived-performance win available.
- **Unlocks historical/trend queries** that are currently impossible or O(full history).
- **Incremental appends**: a source file that grew only ingests the new rows.
- The store is **optional and additive** — the in-memory path stays as a fallback,
  so there is no hard migration for existing users.

## Possible downsides

- **Scope.** This is a multi-day refactor: a new `src/persistence` layer, an
  ingestion seam in `buildUsageEventDataset`, a migration story for users with
  existing parse caches, schema versioning, and a full test matrix. Too large to
  land well in one pass.
- **Correctness risk.** A content-hash collision or a drift between the store and
  the live source files could silently skew reports. Needs an explicit
  `--rebuild-store` / `--ignore-store` escape hatch and a `doctor` check.
- **Storage growth.** Months of events is not large (events are tiny rows), but
  it is unbounded; needs a retention/prune policy.
- **Node 24 `node:sqlite` requirement.** The OpenCode adapter already requires
  it, so this is consistent — but it tightens the runtime floor for the store.

## Confidence

**80%.** The payoff is clearly the highest of any idea, and the design fits the
existing boundaries (parsing in `src/sources`, store in a new `src/persistence`).
The 20% reservation is execution risk: schema versioning, migration, and the
temptation to over-build the query layer. Recommend a minimal v1 (ingest + range
query only) before adding anything fancier.

## Suggested first step

Add the `src/persistence/event-store.ts` interface + a SQLite implementation
behind a feature flag (`LLM_USAGE_EVENT_STORE=1`), wired into
`buildUsageEventDataset` as **write-only** (ingest but still read in-memory).
This proves ingestion idempotency without changing report output, and is a safe,
reversible first commit.
