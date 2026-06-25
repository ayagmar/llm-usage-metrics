# Weakest Parts Remediation Plan

## Purpose

This document is the canonical remediation plan for the weakest parts of the
current `llm-usage-metrics` runtime. It consolidates overlapping findings into a
single priority-ordered execution path so follow-on implementation work can
proceed without reopening architecture decisions.

This is a plan, not an implementation branch.

## Executive Summary

The system's biggest weakness is not table rendering or CLI metadata. It is the
boundary where source discovery, parsing, filtering, pricing, and caching meet.
That boundary currently has three systemic problems:

1. parse results can be stale because cache invalidation does not understand
   auxiliary dependencies
2. filter flags mostly reduce output, not work
3. provider/model/cost identity is still too heuristic in the hot path

The recommended order is:

1. fix correctness bugs first
2. introduce a minimal queryable source contract
3. use that contract for pruning and cache invalidation
4. fix runtime orchestration overhead
5. remove duplicate plumbing and harden tests/docs

## Top Weak Areas

1. **Ingestion/cache boundary**
   The cache assumes a parse result depends only on one discovered file, which
   is false for Droid, Gemini, and OpenCode.

2. **No real query planner**
   The runtime mostly does "select sources, parse everything, then filter."

3. **Model/provider identity is too heuristic**
   Pricing, optimize scoping, and provider/model filtering use overlapping but
   not fully aligned logic.

4. **Runtime orchestration has avoidable friction**
   Parse parallelism is not globally bounded, and startup update checks can cost
   more than the report itself.

5. **Cleanup/test/doc debt exists, but it is not the core problem**
   This work should be done while the main refactors land, not before them.

## Priority Matrix

| Priority | Workstream | Owns | Why now |
| --- | --- | --- | --- |
| P0 | Workstream 1: Dependency-Aware Ingestion and Cache Invalidation | stale cached rows, auxiliary-file correctness | current runs can be fast but wrong |
| P0 | Workstream 2: Pricing Correctness and Priceable Event Semantics | false estimated `$0`, inconsistent priceability rules | directly affects reported spend |
| P1 | Workstream 3: Query Planning and Source Pruning | provider/model/date work reduction, `--model gpt-5.2` scanning Gemini | biggest structural performance gap |
| P1 | Workstream 4: Runtime Orchestration and Latency Control | global parse concurrency, blocking update checks | high user-visible latency and resource spikes |
| P1 | Workstream 5: Identity and Optimize Scope Hardening | mixed-provider optimize runs, repeated pricing resolution heuristics | correctness and maintainability seam |
| P2 | Workstream 6: Plumbing Removal, Tests, Docs, and Observability | duplicate helpers, stale docs, weak branch coverage | keeps refactors from leaving residue |

## Findings Mapped To Workstreams

| Finding | Owner |
| --- | --- |
| parse-cache invalidation is wrong for auxiliary dependencies | Workstream 1 |
| total-only usage can become false estimated `$0` | Workstream 2 |
| filter flags do not reduce work | Workstream 3 |
| `LLM_USAGE_PARSE_MAX_PARALLEL` is per adapter, not global | Workstream 4 |
| startup update checks dominate fast reports | Workstream 4 |
| optimize provider scoping can accept mixed providers | Workstream 5 |
| removable plumbing and duplication | Workstream 6 |
| Gemini discovery walks too much of `.gemini/tmp` | Workstream 3 |

## Standard Verification Loop

Each workstream should follow the same execution loop:

1. add or update regression tests that fail on the current behavior
2. implement the minimal decisive path
3. remove replaced plumbing in the same slice where safe
4. run quality gates:
   - `pnpm run lint`
   - `pnpm run typecheck`
   - `pnpm run test`
   - `pnpm run format:check`
5. run targeted performance validation:
   - `pnpm run perf:report-baseline`
   - any workstream-specific benchmark/fixture checks listed below
6. document behavior changes when they affect contributor workflow or runtime

## Workstream 1: Dependency-Aware Ingestion and Cache Invalidation

### Owns

- auxiliary-file cache invalidation bugs
- stale repo attribution/timestamps/rows from cached parse results
- the contract for what a parse result depends on

### Current Root Cause

`parseAdapterEvents(...)` fingerprints only the discovered file path
(`size`/`mtimeMs`) before consulting `ParseFileCache`.

That is insufficient for:

- Droid, which also reads a sibling `.jsonl`
- Gemini, which also reads `.gemini/projects.json`
- OpenCode, whose effective read state can depend on SQLite sidecar state

### Target Design

Evolve the source contract so source-specific dependencies are owned by the
source, not guessed by CLI-level cache code.

Recommended path:

- add an optional adapter method such as
  `getParseDependencyFingerprints(filePath): Promise<ParseDependencyFingerprint[]>`
- keep the parse cache generic, but let adapters provide all fingerprint inputs
- compute one combined fingerprint from the returned dependency set

This keeps the cache generic while moving correctness knowledge to the adapter
boundary where it belongs.

### Decisive Recommendation

Take a two-step path:

1. immediately disable parse caching for Gemini, Droid, and OpenCode
2. then add adapter-owned dependency fingerprints and re-enable them

Reason:

- the current bug is correctness-impacting
- disabling cache is small and safe
- dependency-aware re-enablement should be deliberate, not rushed

### Planned Phases

#### Phase 1A: Safety First

- disable parse-cache reads/writes for Gemini, Droid, and OpenCode
- add failing regression tests that prove current stale-cache behavior

#### Phase 1B: Dependency Contract

- extend the adapter contract with dependency fingerprint support
- teach Droid to include the sibling JSONL
- teach Gemini to include `projects.json`
- teach OpenCode to include all relevant SQLite state inputs

#### Phase 1C: Re-enable and Clean Up

- restore caching for these sources once dependency fingerprints exist
- delete any temporary source-specific cache bypass plumbing

### Workstream-Specific Verification

- Droid: cached parse invalidates when sibling JSONL changes
- Gemini: cached parse invalidates when `projects.json` changes
- OpenCode: cached parse invalidates when SQLite state changes
- Efficiency reports: repo attribution changes are visible immediately after
  dependency updates

### Success Metrics

- no source can return stale cached rows after any parsing dependency changes
- parse-cache correctness no longer depends on undocumented side effects

## Workstream 2: Pricing Correctness and Priceable Event Semantics

### Owns

- false estimated `$0` for total-only usage
- misalignment between usage pricing and optimize priceability decisions
- cost unknown vs estimated-zero semantics

### Current Root Cause

The runtime decides priceability partly from `totalTokens`, but the cost engine
estimates price only from bucketed fields:

- `inputTokens`
- `outputTokens`
- `reasoningTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

That means an event with only positive `totalTokens` can be marked
`costMode: estimated` and priced as zero, which understates spend.

### Target Design

Introduce one shared `isPriceableEvent(...)` rule used by:

- usage pricing load decisions
- per-event pricing application
- optimize force-pricing eligibility

Recommended semantics:

- only events with billable bucket signal are priceable
- total-only events remain unpriced unless a source explicitly derives bucketed
  fields before `createUsageEvent(...)`
- diagnostics should surface how many events were skipped because they lacked
  billable bucket detail

### Decisive Recommendation

Do not synthesize costs from `totalTokens` alone.

If billable buckets are missing, treat the event as cost-incomplete, not
estimated-zero.

### Planned Phases

#### Phase 2A: Semantics Lock

- add targeted tests for total-only events from Pi and OpenCode
- codify the shared priceability predicate

#### Phase 2B: Pricing Alignment

- reuse the same predicate in usage and optimize
- update diagnostics to expose skipped/unpriceable event counts

#### Phase 2C: Source Follow-Up

- review whether any source should derive missing buckets earlier
- only do this when the source format provides reliable information

### Workstream-Specific Verification

- Pi total-only usage no longer becomes fake `$0`
- OpenCode total-only usage no longer becomes fake `$0`
- optimize and usage agree on whether an event/corpus is priceable

### Success Metrics

- no event with missing billable bucket detail is silently priced as zero
- optimize and usage share one priceability contract

## Workstream 3: Query Planning and Source Pruning

### Owns

- filter flags not reducing work
- `--model gpt-5.2` still scanning Gemini
- Gemini discovery over-traversal
- the first meaningful query-planning layer

### Current Root Cause

The current adapter contract does not accept filter hints, and source selection
only respects `--source`. The result is that discovery/parsing cost is mostly
paid before date/provider/model filters have any effect.

### Target Design

Introduce a minimal queryable source contract with:

- `capabilities.fixedProviderRoots?: string[]`
- optional discovery hints:
  - provider root
  - explicit model filters
  - date range

Then apply pruning in layers:

1. prune entire sources when provider constraints make them impossible
2. prune obvious discovery paths inside a source
3. keep post-parse filtering as the final correctness gate

### Decisive Recommendation

Start conservative:

- provider-root pruning for fixed-provider sources first
- model-to-provider pruning only when an explicit model filter can be resolved
  with high confidence
- do not apply risky substring heuristics to dynamic-provider sources

That means:

- `--provider openai` should prune Gemini immediately
- `--model gpt-5.2` should prune Gemini only after the model filter resolves to
  an OpenAI provider family with high confidence
- Pi/Droid/OpenCode should remain conservative until their metadata says
  otherwise

### Planned Phases

#### Phase 3A: Source Capabilities

- extend adapters with source capabilities metadata
- encode fixed provider roots for at least Codex and Gemini

#### Phase 3B: Pre-Discovery Source Pruning

- teach adapter selection to use `--provider`
- add a conservative model-to-provider inference layer for explicit model
  filters only

#### Phase 3C: In-Source Discovery Pruning

- add discovery hints to the adapter contract
- narrow Gemini discovery to chat paths instead of walking all `.json`
- evaluate whether date-range summaries belong in the parse cache

### Workstream-Specific Verification

- `--provider openai` does not discover/parse Gemini
- `--model gpt-5.2` does not scan Gemini when the model filter resolves
  confidently to OpenAI
- Gemini discovery no longer walks unrelated `.json` trees under `.gemini/tmp`
- output correctness remains identical to the old path for the same data

### Success Metrics

- fixed-provider-incompatible sources are pruned before discovery
- targeted filters reduce total discovery/parsing work, not just output rows

## Workstream 4: Runtime Orchestration and Latency Control

### Owns

- per-adapter instead of global parse concurrency
- startup update checks costing more than report execution

### Current Root Cause

- parse concurrency is configured once but enforced separately inside each
  adapter worker pool
- update checks run synchronously before CLI execution continues

### Target Design

Two runtime changes:

1. replace per-adapter worker pools with one shared global semaphore
2. move update checks to stale-while-revalidate behavior

For update checks, the decisive path is:

- if the cache is fresh, use it synchronously
- if the cache is stale or missing, do not block report execution
- refresh best-effort for the next invocation

### Planned Phases

#### Phase 4A: Global Parse Budget

- introduce one scheduler shared across all adapters
- keep adapter-local parsing logic, but acquire from one global pool

#### Phase 4B: Non-Blocking Update Strategy

- preserve current messaging semantics when a fresh cached update is known
- stop blocking the report on network fetches

#### Phase 4C: Measure and Tune

- compare pre/post perf baseline
- confirm no I/O spike regressions under multi-source runs

### Workstream-Specific Verification

- multi-source runs never exceed the configured global parse concurrency budget
- cold update-cache misses do not materially delay fast commands
- perf baseline remains at least neutral, ideally better

### Success Metrics

- `LLM_USAGE_PARSE_MAX_PARALLEL` becomes a real total cap
- update-check work is no longer able to dominate sub-second report paths

## Workstream 5: Identity and Optimize Scope Hardening

### Owns

- mixed-provider optimize acceptance
- provider/model identity drift
- repeated per-event pricing alias work

### Current Root Cause

Provider filtering, optimize provider resolution, and pricing alias resolution
are related but not fully unified:

- usage filtering is substring-based
- optimize must require a single provider scope
- pricing alias resolution is cached, but still repeated per distinct event model

### Target Design

Introduce a shared provider/model identity layer with:

- canonical provider roots
- explicit provider filter match resolution
- strict optimize scope validation on post-filter canonical providers
- model alias resolution reused once per distinct model where possible

### Decisive Recommendation

- keep current user-facing substring filter semantics for general reports only if
  needed for compatibility
- but make optimize fail fast unless post-filter events collapse to exactly one
  canonical provider root
- pre-resolve pricing once per distinct model in the dataset instead of once per
  event

### Planned Phases

#### Phase 5A: Scope Validation

- add failing tests for mixed-provider optimize runs
- harden optimize to reject ambiguous scopes deterministically

#### Phase 5B: Shared Identity Helpers

- extract provider/model resolution into shared helpers
- remove optimize-only special casing where possible

#### Phase 5C: Pricing Resolution Efficiency

- resolve pricing by distinct model set before per-event repricing
- keep the existing alias cache, but make the common path cheaper

### Workstream-Specific Verification

- optimize fails on mixed canonical providers after filtering
- ambiguous substring matches produce explicit actionable errors
- large distinct-model datasets do less repeated pricing resolution work

### Success Metrics

- optimize provider scope is deterministic and correct
- pricing resolution cost scales with distinct models, not raw event count

## Workstream 6: Plumbing Removal, Tests, Docs, and Observability

### Owns

- duplicate filter helpers
- duplicate `--source-dir` parsing
- unwired `PiSourceAdapter.providerFilter`
- renderer branch coverage gaps
- docs drift with CI
- missing runtime introspection

### Current Root Cause

The codebase has already evolved, but several small parallel paths remain:

- multiple ways to parse/filter the same concepts
- test coverage concentrated on happy paths in some renderers
- contributor docs lagging behind actual CI checks

### Target Design

Trim the runtime surface while the main refactors land:

- keep one filtering path
- keep one `--source-dir` parser
- either wire `PiSourceAdapter.providerFilter` into the new query-planning path
  or remove it
- strengthen targeted coverage where branch behavior remains user-visible
- align `docs/development.md` with actual CI requirements

Also add better runtime observability so future performance work is easier.

### Planned Phases

#### Phase 6A: Plumbing Removal

- delete duplicate helpers once Workstreams 1-5 make them unnecessary
- remove dead option-handling/plumbing paths in the same PR where safe

#### Phase 6B: Test and Docs Hardening

- add targeted terminal renderer branch tests
- update contributor docs to reflect CI and validation expectations

#### Phase 6C: Observability

- add internal timing/counter hooks or a future `--profile-runtime`
  implementation plan

### Workstream-Specific Verification

- no removed helper still has runtime call sites
- docs match CI jobs and required local validation
- targeted renderer branches are exercised by tests

### Success Metrics

- lower duplicate-path count in CLI/runtime code
- stronger confidence in terminal/report edge branches

## Recommended Roadmap

### Phase 0: Safety and Tests

- Workstream 1A
- Workstream 2A
- Workstream 5A

### Phase 1: Correctness Core

- Workstream 1B
- Workstream 2B
- Workstream 5B

### Phase 2: Performance Core

- Workstream 3A
- Workstream 3B
- Workstream 4A
- Workstream 4B

### Phase 3: Re-enable and Optimize

- Workstream 1C
- Workstream 3C
- Workstream 5C
- Workstream 4C

### Phase 4: Cleanup and Hardening

- Workstream 6A
- Workstream 6B
- Workstream 6C

## Fresh Ideas With High Leverage

These are not required to start implementation, but they are the highest-value
future ideas if the maintainers want a cleaner long-term architecture:

1. **Query planner over source capabilities**
   Instead of treating adapters as opaque parsers, let them advertise provider
   roots, dependency fingerprints, cheap discovery summaries, and filter
   support.

2. **Metadata/index layer for discovered files**
   Store cheap summaries such as time bounds, observed providers/models, repo
   roots, and dependency fingerprints so most runs avoid reparsing untouched
   files.

3. **Canonical model/provider identity record**
   Unify filter matching, optimize scope validation, and pricing alias
   resolution behind one normalized identity surface.

4. **Runtime profiling mode**
   Add a future `--profile-runtime` or equivalent debug mode showing:
   - source pruning decisions
   - files discovered
   - files parsed
   - cache hits/misses
   - pricing-resolution counts
   - stage timings

## Exit Criteria

This plan is considered complete when implementation work achieves all of the
following:

- no known stale-cache correctness bugs remain
- no total-only event can become false estimated `$0`
- fixed-provider-incompatible sources are pruned before discovery
- parse concurrency is globally bounded
- update checks no longer dominate fast report execution
- optimize fails fast on mixed provider scopes
- duplicate plumbing introduced by earlier architecture phases is removed
- targeted tests/docs cover the new behavior
