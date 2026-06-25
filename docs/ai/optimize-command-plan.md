# Optimize Command Integration Plan

Add a new CLI command: `llm-usage optimize`, which computes counterfactual (what-if) costs by replaying the user's observed token mix against one or more candidate model pricings.

This plan is written to be iterated on in small Codex-sized milestones with a verification loop after each milestone.

## 1. Scope (V1)

### 1.1 Goal

Given real, filtered, local usage events (already supported by `llm-usage-metrics`), answer:

- What would the same token mix have cost on candidate model(s)?
- What is the absolute and percentage delta versus baseline spend?
- Which candidates are cheapest (ranked), and what pricing coverage is missing?

### 1.2 Non-goals (V1)

- No model recommendation heuristics beyond ranking by hypothetical USD cost.
- No cross-provider normalization or capability matching.
- No "all models" auto-enumeration by provider (candidate set must be explicit).
- No changes to existing usage report semantics, selection policy, provider roots, or ID semantics.

## 2. CLI Surface

### 2.1 Command name and arguments

Add a new command under `llm-usage`:

```
llm-usage optimize <daily|weekly|monthly> [options]
```

Granularity parsing and error semantics should match the existing `efficiency` command.

### 2.2 Options

Reuse all "shared report options" already present on `daily|weekly|monthly`:

- source discovery overrides: `--pi-dir`, `--codex-dir`, `--gemini-dir`, `--droid-dir`, `--opencode-db`, `--source-dir`
- filters: `--source`, `--since`, `--until`, `--timezone`, `--provider`, `--model`
- pricing controls: `--pricing-url`, `--pricing-offline`, `--ignore-pricing-failures`
- outputs: `--json`, `--markdown`

Add new optimize-only options:

- `--candidate-model <name>` (repeatable and/or comma-separated; normalization rules below)
- `--top <n>` (optional; when set, show best `n` candidates)

Do not expose `--per-model-columns` on `optimize` (it has no meaning for this report). Mirror the `efficiency` command pattern by using shared options with `includePerModelColumns: false`.

Option parsing conventions:

- Implement `--candidate-model` with the same repeated-option collector used by `--model` and `--source` (Commander receives an array of raw strings; normalization splits comma segments).

### 2.3 Validation rules

- Require at least one candidate model:
  - If none provided (including Commander default `[]`), throw an actionable error: `At least one --candidate-model is required`.
- Candidate model normalization must reject empty values (including empty comma segments):
  - `--candidate-model must contain at least one non-empty model name`
- Output formats:
  - Reject mutually exclusive `--json` and `--markdown` with the same error string used elsewhere:
    - `Choose either --markdown or --json, not both`
- `--top` parsing:
  - Must be a positive integer (`>= 1`), else throw: `--top must be a positive integer`
- Provider scope:
  - `optimize` requires a single provider context.
  - After baseline filtering is applied, collect distinct non-empty `event.provider` values (trim + lowercase).
  - Keep existing `--provider` semantics unchanged (`substring` match in the usage filter); optimize validation is based on the post-filter event set.
  - If more than one distinct provider exists, fail with a message that includes the detected providers:
    - `Optimize requires a single provider; found providers: <p1>, <p2>. Narrow with --provider.`
  - Provider lists in errors must be deterministic (sort by code point).
  - Run this validation after parsing/filtering but **before** pricing load so we fail fast without unnecessary work/network fetch.

Note: If the filtered usage set includes zero events, still emit a valid report with all-zero baseline totals. Candidate costs are deterministically zero only when all token buckets are zero (`inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`); do not rely on `totalTokens` alone because it is source-defined.

## 3. Data Contracts

### 3.1 Options type

Add a new CLI options type in `src/cli/usage-data-contracts.ts`:

- `OptimizeCommandOptions = Omit<ReportCommandOptions, 'perModelColumns'> & { candidateModel?: string | string[]; top?: string }`

Notes:
- `top` arrives as string from Commander; normalize to number with validation (positive integer, `>= 1`).

### 3.2 Output row types (V1)

Introduce a small domain contract for optimize output (new module under `src/optimize/`):

- `OptimizeRow` with `rowType`:
  - `baseline`
  - `candidate`

Suggested fields:

- common:
  - `rowType`
  - `periodKey` (computed via `getPeriodKey`; `ALL` for grand total)
  - `provider` (resolved baseline provider context for the optimize run)
  - `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`
- baseline row:
  - `baselineCostUsd` (number | undefined)
  - `baselineCostIncomplete` (boolean)
- candidate row:
  - `candidateModel` (string, normalized candidate key used for ranking/lookup)
  - `candidateResolvedModel` (string, after pricing alias resolution; useful for debugging)
  - `hypotheticalCostUsd` (number | undefined)
  - `hypotheticalCostIncomplete` (boolean)
  - `savingsUsd` (number | undefined) (defined as `baselineCostUsd - hypotheticalCostUsd`)
  - `savingsPct` (number | undefined)
  - `notes` (string[] | undefined) (stable tags; see below)

`notes` tags (deterministic, sorted by code point when multiple):

- `missing_pricing`
- `baseline_incomplete`
- `baseline_tokens_missing`

Token fields in rows:

- For both baseline and candidate rows, token totals reflect the observed baseline usage for that `periodKey` (candidate rows do not change token counts; they only change pricing).

### 3.3 Result + diagnostics type

Add:

- `OptimizeDiagnostics`:
  - `usage` (reuse `UsageDiagnostics`)
  - `provider`
  - `baselineCostIncomplete` (grand total / `periodKey = 'ALL'`)
  - `candidatesWithMissingPricing` (string[])
  - `warning?: string` (optimize-specific warning message when inputs make counterfactual savings misleading; if multiple periods trigger it, emit a single combined message with sorted period keys for stable output)
- `OptimizeDataResult`:
  - `rows: OptimizeRow[]`
  - `diagnostics: OptimizeDiagnostics`

## 4. Computation / Algorithm

### 4.1 Baseline event set

Build the baseline events by reusing the same parsing and filtering modules as the usage pipeline (to avoid semantic drift), but do not call `buildUsageData` directly because it does not expose the loaded `PricingSource` (needed for counterfactual evaluation).

Avoid duplication:

- Do not re-implement the `buildUsageData` orchestration separately for `optimize`.
- Extract the orchestration in `buildUsageData` into a shared internal helper (in `src/cli/`) that returns:
  - parsed adapter results + failures
  - filtered baseline events
  - normalized inputs (timezone/provider/model/source/pricing-url)
  - pricing application result when attempted (origin + warning + priced events)
  - a handle to the loaded `PricingSource` when pricing is loaded (needed for counterfactual evaluation)
- Have both `buildUsageData` and `buildOptimizeData` call this helper, so parsing/filtering/pricing behavior cannot drift across commands.
- The helper must support a pricing-load mode:
  - `auto` (preserve current `buildUsageData` behavior exactly; no semantic change)
  - `force` (optimize behavior: load pricing whenever counterfactual evaluation needs it, unless all token buckets are zero for `ALL`)
- Pricing implementation must reuse existing pricing helpers instead of duplicating logic:
  - refactor `resolveAndApplyPricingToEvents(...)` to optionally return the `PricingSource` it loaded
  - extend it (or add a thin wrapper) to support `pricingLoadMode: auto|force` so `optimize` can force-load pricing once (without re-implementing warning/error handling)

Shared helper flow (mirrors current `buildUsageData` behavior):

- normalize and validate inputs via `normalizeBuildUsageInputs(options)` (date/timezone/provider/model/source/pricing-url)
- create and select adapters via `createDefaultAdapters(options)` + `selectAdaptersForParsing(...)`
- parse via `parseSelectedAdapters(...)` with parse-cache runtime config
- enforce explicit-source failure semantics via `throwOnExplicitSourceFailures(...)`
- filter events via `filterParsedAdapterEvents(...)` using the same provider/date/model matching rules

### 4.2 Baseline totals

From the filtered baseline events:

1. Load a pricing source once when needed (see 4.4) and apply it to baseline events so baseline cost matches the existing cost engine semantics (including explicit-zero repricing).
   - If pricing is skipped or unavailable, proceed with the unpriced baseline events; baseline cost will reflect explicit costs only and will be marked incomplete when costs are unknown (consistent with existing reports when pricing is missing).
2. Reuse the existing aggregator to compute period totals and cost rounding:
   - `usageRows = aggregateUsage(pricedBaselineEvents, { granularity, timezone, sourceOrder: adaptersToParse.map((a) => a.id) })`
3. Resolve baseline totals per period from `usageRows`:
   - For each `periodKey` (excluding `ALL`):
     - prefer the `period_combined` row when present
     - otherwise, use the single `period_source` row (when `aggregateUsage` does not emit `period_combined`, it means exactly one source contributed events for that period)
   - Do not recompute sums outside `aggregateUsage` unless required for a verified edge case; this avoids duplicating cost rounding / `costIncomplete` semantics.
   - For grand total, use the `grand_total` row (`periodKey = 'ALL'`) from `usageRows`.
4. Map baseline totals into optimize baseline rows:
   - token fields are copied from the resolved baseline totals
   - `baselineCostUsd = costUsd`
   - `baselineCostIncomplete = costIncomplete === true` (normalize `undefined` to `false`)

Token semantics:

- `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens` are summed from their respective event fields.
- `totalTokens` is the sum of `event.totalTokens` (source-defined and not guaranteed to equal the sum of other token buckets).

### 4.3 Single-provider enforcement

Determine provider scope:

- Infer from filtered events first:
  - Inspect filtered events' `provider` values (trim + lowercase, ignore empty/undefined).
  - If more than one distinct provider exists, throw (see validation rule). Do this **before** attempting to load pricing to avoid unnecessary work/network fetch.
  - If exactly one exists, use it.
- If no non-empty provider values exist (e.g. empty dataset, or sources that omit provider):
  - fall back to `normalizeProviderFilter(options.provider)` when present (this may be a substring filter, so treat it as a label only)
  - otherwise, set provider to `unknown`.

### 4.4 Counterfactual pricing

#### 4.4.1 Candidate model normalization

Normalize candidate models similarly to `--model`/`--source` collection rules, but with exact-match semantics:

- if Commander collected no values (`undefined` or `[]`), throw: `At least one --candidate-model is required`
- otherwise, collect raw values from Commander (repeatable `--candidate-model`), then:
  - split on `,`
  - trim
  - lowercase
  - drop empty segments
  - de-duplicate
- if the normalized result is empty (e.g. only empty/whitespace/comma segments were provided), throw: `--candidate-model must contain at least one non-empty model name`

#### 4.4.2 Pricing source load (single load)

Load the pricing source exactly once (same machinery used by the usage pipeline):

- Use the normalized pricing URL from `normalizeBuildUsageInputs(options)` when loading pricing (equivalent to `buildUsageData`'s `withNormalizedPricingUrl(...)` behavior).
- Determine whether pricing is needed by computing the grand-total token bucket totals (`periodKey = 'ALL'`) from the filtered baseline events (no pricing required).
- Do not change `shouldLoadPricingSource(...)` semantics used by usage reports (`auto` mode currently keys off `totalTokens` + cost state). Implement optimize-specific `force` eligibility separately so existing usage behavior/tests remain unchanged.
- Skip loading pricing entirely when the grand-total baseline token totals are all zero (for `periodKey = 'ALL'`):
  - `inputTokens === 0`
  - `outputTokens === 0`
  - `reasoningTokens === 0`
  - `cacheReadTokens === 0`
  - `cacheWriteTokens === 0`
  Rationale: `totalTokens` is source-defined and may exclude reasoning/cache groups (e.g. Codex), so zero-cost decisions must not rely on `totalTokens`.
- Otherwise, load pricing via the shared pricing helper (`resolveAndApplyPricingToEvents(...)`) in `force` mode so the loaded `PricingSource` can be reused for candidates.
  - If pricing fails to load:
    - if `--ignore-pricing-failures` is not set: throw
    - else: continue with `pricingOrigin = 'none'`, set a `pricingWarning` (same formatting as existing reports), and treat candidate pricing as missing

When a pricing source exists, use the `pricedEvents` returned by the pricing helper for baseline aggregation (do not apply pricing twice).

#### 4.4.3 Candidate evaluation

Evaluate each candidate model against each period's baseline token totals:

Precondition:

- If no pricing source is available (pricing load failed and `--ignore-pricing-failures` is set), treat all candidates as "missing pricing" (skip alias resolution and set `candidateResolvedModel = candidateModel`).

1. When a pricing source exists, resolve alias: `resolved = pricingSource.resolveModelAlias(candidateModel)`.
2. When a pricing source exists, fetch pricing using the resolved key: `pricing = pricingSource.getPricing(resolved)`.
3. If no pricing:
   - for periods where all token buckets are zero:
     - `inputTokens === 0`
     - `outputTokens === 0`
     - `reasoningTokens === 0`
     - `cacheReadTokens === 0`
     - `cacheWriteTokens === 0`
     set `hypotheticalCostUsd = 0` and `hypotheticalCostIncomplete = false`
   - otherwise:
      - set `hypotheticalCostUsd = undefined`
      - set `hypotheticalCostIncomplete = true`
      - `notes` includes `missing_pricing`
4. Else:
   - compute `hypotheticalCostUsd` from baseline token totals using the same cost-engine semantics:
     - recommended: create a minimal synthetic `UsageEvent` and call `calculateEstimatedCostUsd(event, pricing)`
     - ensure reasoning billing rules are respected (`reasoningBilling` default vs separate)
     - apply the same USD rounding strategy as `aggregateUsage` / `aggregateEfficiency` (scale `1_000_000_000_000`) to keep values stable
       - do **not** attempt to import their internal `USD_PRECISION_SCALE` constants (they are not exported)
       - either define a local `roundUsd(value)` helper in `src/optimize/` (documented to match existing aggregators), or extract a shared utility if refactoring is already in-scope for the milestone
   - compute deltas:
     - if `baselineCostIncomplete` or `baselineCostUsd === undefined` then `savingsUsd` and `savingsPct` should be `undefined` and `notes` include `baseline_incomplete`
     - if all token buckets are zero for the period (input/output/reasoning/cache read/cache write) but `baselineCostUsd > 0`, then:
       - set `savingsUsd` and `savingsPct` to `undefined`
       - set `notes` to include `baseline_tokens_missing`
       - set `OptimizeDiagnostics.warning` to an actionable warning string (log to `stderr`)
     - else:
       - `savingsUsd = roundUsd(baselineCostUsd - hypotheticalCostUsd)` (match USD precision strategy for stable output)
       - `savingsPct = baselineCostUsd === 0 ? undefined : savingsUsd / baselineCostUsd`

`candidateResolvedModel` rules:

- When a pricing source exists: set `candidateResolvedModel = resolved` (even if pricing is missing for that resolved key).
- When no pricing source exists: set `candidateResolvedModel = candidateModel`.

### 4.5 Sorting and limiting

Sort candidates (deterministically) using the grand total period (`periodKey = 'ALL'`) hypothetical cost:

1. candidates with `hypotheticalCostUsd` ascending
2. candidates with `hypotheticalCostUsd === undefined` last
3. deterministic tie-break: `candidateModel` code-point order

Apply `--top` after sorting, but do so using the `ALL` period ranking to keep the same candidate set across periods (stable comparisons). When `--top` is not set, include all candidates.
If `--top` exceeds the number of candidates, include all candidates (no error).

Row ordering rules:

- Period ordering: ascending `periodKey` (code point), with `ALL` emitted last.
- Within a period: emit the baseline row first, then candidate rows in the `ALL` ranking order (do not re-rank per-period).

### 4.6 Diagnostics assembly

Build optimize diagnostics by composition (mirror existing patterns):

- `diagnostics.usage`: build via `buildUsageDiagnostics(...)` using:
  - `adaptersToParse`
  - `successfulParseResults`
  - `sourceFailures`
  - `pricingOrigin` and `pricingWarning`
  - `activeEnvOverrides` (from `getActiveEnvVarOverrides()`)
  - `timezone`
- optimize-specific fields:
  - `provider` (from 4.3)
  - `baselineCostIncomplete` from the `periodKey = 'ALL'` baseline row
  - `candidatesWithMissingPricing`: candidate models whose pricing is unavailable when any token bucket is non-zero in the `ALL` baseline totals (or all candidates when pricing load failed and `--ignore-pricing-failures` is set)
    - ordering must be deterministic (sort by code point)

## 5. Rendering

### 5.1 Formats

Implement `renderOptimizeReport(result, format, options)` in `src/render/`:

- `terminal` (default): header + unicode table
- `markdown`: markdown table
- `json`: `JSON.stringify(rows, null, 2)` (rows only, consistent with existing renderers)

Recommended terminal/markdown columns:

- `Period`
- `Candidate` (use `BASELINE` label for baseline rows)
- `Hypothetical Cost`
- `Baseline Cost` (for baseline rows, same as baseline cost; for candidates, repeat baseline cost for readability)
- `Savings` (USD)
- `Savings %`
- `Notes`

Rendering rules:

- For baseline rows:
  - `Candidate = BASELINE`
  - `Hypothetical Cost = -`
  - `Baseline Cost = baselineCostUsd` (use `~$` prefix when incomplete, `-` when undefined)
  - `Savings` and `Savings %` render as `-`
- For candidate rows:
  - `Hypothetical Cost = hypotheticalCostUsd` (use `-` when undefined)
  - `Baseline Cost` repeats the baseline cost for that period
  - `Savings`/`Savings %` render as `-` when undefined
  - `Notes`:
    - render `-` when `notes` is missing or empty
    - otherwise join tags with `, ` (tags are already sorted deterministically by code point)

Percent formatting:

- In JSON rows: `savingsPct` is a ratio (e.g. `0.1234` means 12.34%).
- In terminal/markdown: render `Savings %` as a percentage string with 2 decimal places (multiply by 100 and append `%`), or `-` when undefined.

Note: token totals are part of the row contract for `--json` consumers, but terminal/markdown output may intentionally omit token columns to stay readable (users can run `llm-usage <daily|weekly|monthly>` for full token breakdown tables).

### 5.2 Output invariants

- `stdout` contains only report body (especially for `--json` / `--markdown`).
- Diagnostics remain on `stderr` through the existing diagnostics emission pipeline.
- Stable column ordering and deterministic row ordering.

## 6. Integration Points (Code)

Add the following production modules, mirroring existing patterns:

- `src/cli/build-usage-event-dataset.ts` (new shared helper)
  - extracted orchestration from `buildUsageData` (see 4.1)
  - used by both `buildUsageData` and `buildOptimizeData` to prevent drift/duplication
- `src/cli/build-optimize-data.ts`
  - `buildOptimizeData(granularity, options, deps?) => OptimizeDataResult`
  - `deps` should mirror `BuildUsageDataDeps` injection points (parsing/pricing runtime config, adapter creation, pricing source resolver, env-var overrides) so optimize tests can be deterministic without global stubs/network.
- `src/cli/run-optimize-report.ts`
  - `buildOptimizeReport(...) => string`
  - `runOptimizeReport(...) => void` (prints to stdout and emits diagnostics)
- `src/render/render-optimize-report.ts`
- `src/optimize/` (new folder)
  - `aggregate-counterfactual.ts` (pure computations + sorting)
  - `optimize-row.ts` (row types/contracts)

Wire into CLI:

- `src/cli/create-cli.ts`
  - register `optimize` command at the root level alongside `daily|weekly|monthly|efficiency`
  - add one help example for optimize to root help output (keep it short)
- `src/update/update-notifier.ts`
  - include `optimize` in recognized command names used by `shouldSkipUpdateCheckForArgv(...)` to avoid misclassifying `optimize help` as top-level help

Runner behavior should mirror existing commands:

- call `emitDiagnostics(diagnostics.usage, logger)` and `emitEnvVarOverrides(...)`
- log optimize-specific summary lines to `stderr` (provider scope, candidate count, missing pricing summary)
- when `OptimizeDiagnostics.warning` is present, emit it as a warning on `stderr`
- call `warnIfTerminalTableOverflows(...)` when rendering terminal output
- emit diagnostics and env-var overrides before printing the report output to `stdout`

## 7. Test Plan

### 7.1 Unit tests (pure logic)

Add tests under `tests/optimize/` (new):

- counterfactual cost math matches `calculateEstimatedCostUsd` semantics
- missing pricing yields `hypotheticalCostUsd === undefined` and sorts last
- baseline incomplete suppresses delta computation
- candidate-model normalization splits commas, trims, lowercases, and de-duplicates deterministically
- `--top` selection is based on the `ALL` ranking and is stable across periods

Use `tests/helpers/static-pricing-source.ts` to avoid network and keep results deterministic.

### 7.2 CLI parsing tests

Add `tests/cli/create-cli-optimize-command.test.ts` similar to existing efficiency parsing tests:

- `optimize monthly --candidate-model x --json` dispatches to `runOptimizeReport('monthly', ...)`
- invalid granularity rejected with the same message as efficiency
- ensure `--per-model-columns` is not present on the optimize command

Update existing CLI tests impacted by new command registration:

- `tests/cli/create-cli.test.ts` must include `optimize` in the registered command list.
- update any help-output assertions impacted by adding a new root example line for `optimize`.
- update the existing "report commands include shared flags" test to avoid asserting `--per-model-columns` on the `optimize` command.

### 7.3 CLI behavior tests (builder/runner)

Add `tests/cli/run-optimize-report.test.ts`:

- rejects `--json` + `--markdown`
- prints title in terminal format and emits a table header
- produces deterministic JSON rows (baseline then ranked candidates)
- keeps diagnostics on `stderr` and report body on `stdout` (especially for `--json` / `--markdown`)
- provider validation: fails when multiple providers are present after filtering and `--provider` is not supplied
- empty usage set:
  - baseline grand total cost is `0` and incomplete is `false`
  - candidate hypothetical cost is `0` even when pricing is unavailable
- reasoning-only usage (possible when `totalTokens` excludes reasoning):
  - if `reasoningTokens > 0` and pricing is unavailable, candidate hypothetical cost must be `undefined` (do not incorrectly treat it as zero)
- tokenless cost (rare but possible in malformed inputs):
  - if all token buckets are zero but baseline cost is positive, savings must be omitted and a warning emitted on `stderr`

Where possible, build events via `createUsageEvent` and mock adapter outputs like `tests/cli/build-usage-data.test.ts` does.

### 7.4 Rendering tests

Add `tests/render/render-optimize-report.test.ts`:

- terminal contains report title and expected column headers
- markdown contains `| Candidate |`
- json parses into expected row objects

### 7.5 Update Notifier Regression Test

Update `tests/update/update-notifier.test.ts`:

- include a case that `shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'optimize', 'help'])` is `false` (mirrors existing `efficiency help` behavior where `help` is a positional value, not top-level help)

## 8. Verification Loop (Mandatory Each Milestone)

After each milestone, run:

```
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run format:check
```

Add a fast local CLI sanity check (offline/pricing deterministic):

```
pnpm run cli -- optimize daily --source droid --droid-dir tests/fixtures/droid/report --timezone UTC --candidate-model gpt-4.1 --pricing-offline --ignore-pricing-failures --json
```

Acceptance criteria per run:

- no diagnostics on `stdout` for `--json` / `--markdown`
- deterministic output ordering
- errors are actionable and stable (tests assert exact messages)

## 9. Milestones (Codex-Iterable Tasks)

### Milestone 1: Pure Counterfactual Engine

- Create `src/optimize/aggregate-counterfactual.ts` with pure input/output.
- Add unit tests for sorting, missing pricing, baseline incomplete.

### Milestone 2: Contracts + Renderer

- Add `OptimizeRow`, `OptimizeDataResult`, `OptimizeDiagnostics`.
- Implement `renderOptimizeReport` with `terminal|markdown|json`.
- Add rendering tests.

### Milestone 3: CLI Wiring (Parsing Only)

- Add `optimize` command to `createCli`.
- Add parsing tests that validate dispatch and granularity normalization.
- Update update-notifier command-name recognition + regression test for `optimize help` argument shape.

### Milestone 4: Build + Run Optimize Report

- Refactor `buildUsageData` to delegate its orchestration to the shared helper (`src/cli/build-usage-event-dataset.ts`) with `pricingLoadMode: auto` (no behavior changes).
- Refactor `resolveAndApplyPricingToEvents(...)` (or add a thin wrapper around it) so it can:
  - return the loaded `PricingSource` handle when pricing is loaded
  - support `pricingLoadMode: auto|force` so `optimize` can force-load pricing once for counterfactual evaluation
- Implement `buildOptimizeData` using the same helper with `pricingLoadMode: force` while keeping a handle to the loaded `PricingSource` for counterfactual evaluation.
- Implement `buildOptimizeReport` / `runOptimizeReport`.
- Add CLI behavior tests, including output flag validation.

### Milestone 5: Documentation (Site)

- Add a site docs page describing `optimize` semantics and example workflows:
  - `site/src/content/docs/optimize.mdx` (new) with examples and caveats (single-provider enforcement, missing pricing, baseline incomplete)
- Add the new docs page to site navigation:
  - update `site/astro.config.mjs` sidebar to include an `Optimize` entry (link `/optimize`) near `Efficiency`/`Output Formats`
  - update `site/src/content/docs/index.mdx` Quick Navigation cards and Key Commands to mention `optimize`
- Update `site/src/content/docs/output-formats.mdx` to include `optimize` examples and clarify its JSON/Markdown semantics.
- Update `README.md` to include `optimize` in the Features list and add at least one usage example.
- Update `scripts/generate-cli-reference.mjs`:
  - add `optimize <daily|weekly|monthly>` to `commandReferences`
  - mark `--candidate-model` and `--top` as `(optimize only)` in the generated descriptions (add a small `optimizeOnlyOptions` set, mirroring the existing `efficiencyOnlyOptions` / `usageOnlyOptions`)
  - add at least one `optimize` example line in the generated "Examples" block
  - (optional but recommended) strip any existing `(... only)` suffixes consistently, including `(optimize only)`, before re-appending, to keep output stable/idempotent
- Regenerate CLI reference (`pnpm run site:docs:generate`) and validate output.
  - Ensure `optimize` appears in `site/src/content/docs/cli-reference.mdx`.
  - Update architecture docs to include the `optimize` path:
    - `docs/architecture.md`
    - `site/src/content/docs/architecture/index.mdx`

## 10. Definition of Done (V1)

- `llm-usage optimize <granularity>` exists and is documented.
- Counterfactual ranking is deterministic and correct for input/output/reasoning/cache token groups.
- Missing pricing and baseline-incomplete scenarios are surfaced clearly (notes + diagnostics) without crashing.
- Full verification loop passes locally:
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run test`
  - `pnpm run format:check`
