# Report Architecture Rewrite Plan

## Recommendation

Do this rewrite **before** implementing `docs/ai/trends-plan.md`.

Given the desired quality bar, adding `trends` directly on top of the current
structure would deepen an architectural pattern that is already stretching:

- command option wiring is too ad hoc for another specialized report
- runner lifecycle logic is duplicated across report commands
- report docs metadata is partially duplicated outside the CLI
- non-usage reports are forced through usage-table-specific rendering metadata
- aggregation always computes model breakdowns even when the caller never uses
  them

This plan is intentionally broader than the narrow
`report-command-foundation-plan.md`. It sets up a durable report architecture
for `usage`, `efficiency`, `optimize`, and `trends`.

## Quality bar

This rewrite is justified only if it delivers:

1. clearer ownership boundaries
2. less duplication
3. fewer fake adapter layers / fake row conversions
4. simpler future command additions
5. no behavioral regressions for existing commands

If an abstraction does not clearly improve those outcomes, do not add it.

## Goals

1. Establish a single report-command architecture for all report types.
2. Move shared command metadata into one canonical source.
3. Move shared runner lifecycle behavior into one canonical source.
4. Reduce report-specific duplication without hiding real behavioral differences.
5. Introduce aggregation profiles so reports only compute what they need.
6. Keep stdout/stderr, help text, JSON/Markdown semantics, and share semantics
   stable.
7. Eliminate docs drift by updating architecture docs to match the rewritten
   module structure and deriving CLI docs from shared report metadata.
8. Keep a single source of truth for command metadata without introducing a
   second source of truth for option descriptions.

## Non-goals

- no source-adapter rewrite
- no pricing-engine rewrite
- no redesign of output visuals
- no replacement of Commander
- no generic plugin system
- no broad docs-site redesign

## Architectural problems in the current codebase

### 1. Command definitions are not first-class

`src/cli/create-cli.ts` hand-builds each command imperatively.

Consequences:

- option surface rules are encoded inline
- root help examples are hand-maintained
- command capabilities are not represented as data
- adding `trends` requires more branching in `create-cli.ts`

### 2. Runner lifecycle is duplicated

`run-usage-report.ts`, `run-efficiency-report.ts`, and
`run-optimize-report.ts` each duplicate some combination of:

- output format validation/resolution
- report preparation shape
- diagnostics emission
- env override emission
- terminal overflow warning policy
- share artifact write/open/log handling
- stdout printing

### 3. Docs metadata is partially duplicated outside the CLI

`scripts/generate-cli-reference.mjs` has a second manual command list plus
manual option-scope sets.

Consequences:

- command/docs drift risk
- every new command requires multiple updates
- command capabilities are not centrally described

### 4. Generic table rendering is coupled to `UsageReportRow`

`renderUnicodeTable(...)` depends on `UsageReportRow` row semantics for sorting
and separator behavior, so optimize and efficiency manufacture fake
`UsageReportRow` objects just to render tables.

That is a real architectural smell.

### 5. Aggregation does unnecessary work

`aggregateUsage(...)` always computes model lists and model breakdowns even for:

- `efficiency`
- `optimize`
- planned `trends`

Those reports only need period totals.

## Target architecture

The rewrite should introduce four explicit layers.

### Layer 1: Report definitions

Each report command should be represented by two related but distinct
definition layers:

- pure metadata definitions
- runtime report definitions

Pure metadata definitions are for:

- command identity
- argument shape
- shared option profile
- format support
- share support
- docs/help metadata

Runtime report definitions are for:

- builder
- renderer
- runner-specific diagnostics hook
- optional terminal overflow policy hook
- optional share hook

This should be data-first, not inheritance-heavy.

Suggested location:

- `src/cli/report-definitions/`

Suggested core types:

```ts
type ReportDefinitionMeta = {
  commandName: string;
  kind: 'usage-granularity' | 'specialized';
  description: string;
  sharedOptions: SharedOptionProfile;
  supports: {
    markdown: boolean;
    json: boolean;
    share: boolean;
  };
  helpExamples: string[];
};

type ReportRuntimeDefinition = {
  meta: ReportDefinitionMeta;
  register(command: Command): void;
};
```

Important:

- usage `daily|weekly|monthly` may still be represented by one family
  definition, not three unrelated definitions
- do not force every report into identical runtime data/result types
- docs generation should depend on `ReportDefinitionMeta`, not on runtime
  builder/renderer hooks

### Layer 2: Shared runner lifecycle

Introduce a shared report runner lifecycle with explicit hooks rather than
duplicated orchestration code in each file.

Suggested location:

- `src/cli/report-runtime/`

Responsibilities:

- resolve output format
- validate format support
- run builder
- run renderer
- emit common diagnostics/env override hooks
- apply optional terminal overflow hook
- apply optional share artifact hook
- print stdout body

This should still allow report-specific hooks for:

- extra diagnostics logs
- share eligibility constraints
- overflow policy

The goal is not “one function to rule them all.” The goal is to remove proven
duplication while keeping report-specific policy explicit.

### Layer 3: Shared report metadata for docs generation

The docs generator should consume report definition metadata instead of carrying
a second manual command registry.

Suggested outcome:

- `create-cli.ts` builds commands from report metadata + runtime bindings
- `scripts/generate-cli-reference.mjs` reads the same definitions for command
  labels/examples/option scopes
- root help examples should also derive from the same metadata, with only truly
  dynamic content (for example supported source IDs) composed at runtime

This should eliminate manual duplication of:

- command list
- command labels
- command-scoped option classification
- examples block

This layer is also the core anti-drift mechanism for CLI docs:

- CLI command registration and generated CLI docs should read from the same
  metadata source
- adding or changing a report command should not require parallel CLI/docs
  registries
- option descriptions themselves should continue to come from actual Commander
  help output, so we do not create a new parallel description registry

### Layer 4: Aggregation profiles

`aggregateUsage(...)` should support a profile that allows callers to opt out of
model breakdown computation when they only need totals.

Suggested option:

```ts
type AggregateUsageOptions = {
  granularity: ReportGranularity;
  timezone: string;
  sourceOrder?: string[];
  includeModelBreakdown?: boolean;
};
```

Default remains `true` for backward compatibility within the rewrite branch,
but the goal is that:

- usage reports pass `true`
- efficiency passes `false`
- optimize passes `false`
- trends passes `false`

This is both a maintainability and performance win.

## Workstream 1: Report Definition Registry

### Goal

Replace imperative scattered command capability wiring with explicit report
definitions.

### Scope

- add report definition types
- add shared option profile types
- add command factories that consume definitions
- migrate `usage`, `efficiency`, and `optimize`

### Requirements

- no behavior change in help output
- no behavior change in command names/args
- no behavior change in existing supported flags
- command ordering and option ordering remain stable

### Verification loop

After this milestone:

- `create-cli` tests stay green
- root help text stays functionally identical
- command option surfaces stay identical

Commands:

```bash
pnpm run test -- tests/cli/create-cli.test.ts tests/cli/create-cli-efficiency-command.test.ts tests/cli/create-cli-optimize-command.test.ts
pnpm run typecheck
```

## Workstream 2: Shared Runner Lifecycle

### Goal

Refactor the three existing runners onto a single explicit lifecycle surface.

### Scope

- extract shared output-format support/validation
- extract shared stdout/stderr flow
- extract shared share-artifact handling
- keep report-specific diagnostics hooks explicit
- preserve the existing `build...Report(...)` and `run...Report(...)` entry
  points as thin wrappers over the new lifecycle

### Requirements

- preserve `Choose either --markdown or --json, not both`
- preserve existing stderr ordering as much as practical
- preserve existing share log strings
- preserve existing share file names
- preserve the existing callable surfaces used by tests and internal consumers:
  `buildUsageReport`, `runUsageReport`, `buildEfficiencyReport`,
  `runEfficiencyReport`, `buildOptimizeReport`, `runOptimizeReport`

### Verification loop

After this milestone:

- usage/efficiency/optimize runner tests still pass
- JSON output remains data-only on stdout
- diagnostics remain on stderr
- existing builder/runner entry points still work without caller changes

Commands:

```bash
pnpm run test -- tests/cli/run-usage-report.test.ts tests/cli/run-efficiency-report.test.ts tests/cli/run-optimize-report.test.ts
pnpm run typecheck
```

## Workstream 3: Generic Table Metadata Decoupling

### Goal

Stop requiring optimize and efficiency renderers to fabricate `UsageReportRow`
objects just to use `renderUnicodeTable(...)`.

### Scope

Refactor `renderUnicodeTable(...)` to depend on explicit row metadata instead of
`UsageReportRow`.

Suggested concept:

```ts
type TableRowMeta = {
  periodKey: string;
  rowKind: 'detail' | 'combined' | 'total';
};
```

This gives the table renderer what it actually needs:

- sort period rows deterministically
- draw separators between groups
- render total rows last

Without coupling it to usage-domain row types.

Also remove usage-domain naming leaks from the generic table API where practical.
For example, generic table configuration should not continue to expose
usage-specific parameter names like `usageRows` or `modelsColumnIndex` once the
renderer is no longer usage-domain-specific.

### Requirements

- do not regress table layout or separators
- usage report tables remain visually identical
- optimize/efficiency renderers stop manufacturing fake usage rows

### Verification loop

After this milestone:

- usage, optimize, and efficiency renderer tests stay green
- Unicode table tests stay green
- optimize/efficiency renderers no longer construct fake `UsageReportRow`
  objects solely for table rendering

Commands:

```bash
pnpm run test -- tests/render/unicode-table.test.ts tests/render/render-usage-report.test.ts tests/render/render-efficiency-report.test.ts tests/render/render-optimize-report.test.ts
pnpm run typecheck
```

## Workstream 4: Aggregation Profiles

### Goal

Allow non-usage reports to aggregate totals without paying the complexity and
runtime cost of model breakdown computation.

### Scope

- extend `aggregateUsage(...)`
- preserve existing default behavior
- migrate efficiency and optimize to `includeModelBreakdown: false`
- ensure trends can build on the same optimized path

### Requirements

- usage output remains unchanged
- optimize and efficiency totals remain unchanged
- deterministic period/source ordering remains unchanged

### Verification loop

After this milestone:

- aggregate tests stay green
- build-efficiency/build-optimize tests stay green
- e2e usage report tests stay green

Commands:

```bash
pnpm run test -- tests/aggregate/aggregate-usage.test.ts tests/cli/build-efficiency-data.test.ts tests/optimize/aggregate-counterfactual.test.ts tests/e2e/usage-report.e2e.test.ts
pnpm run typecheck
```

## Workstream 5: Docs Generator Convergence

### Goal

Make the CLI docs generator consume the same report metadata used by the CLI.

### Scope

- remove manual command list duplication where practical
- remove manual option-scope duplication where practical
- keep generated output stable
- update architecture docs to reflect the new report-definition/runtime module
  layout

### Requirements

- generated `cli-reference.mdx` should not materially change except where the
  metadata source now comes from shared definitions
- release/docs generation flow stays intact
- contributor and site architecture docs must match the rewritten structure

### Verification loop

After this milestone:

- regenerate CLI docs
- update architecture docs
- diff generated output for unexpected changes
- site checks still pass

Commands:

```bash
pnpm run site:docs:generate
pnpm run site:check
pnpm run typecheck
```

Files expected to change in this milestone:

- `docs/architecture.md`
- `site/src/content/docs/architecture/index.mdx`
- `site/src/content/docs/cli-reference.mdx` (generated)

Follow-up requirement after this milestone:

- reconcile `docs/ai/trends-plan.md` against the rewritten architecture before
  starting trends implementation, so the trends plan references the new seams
  rather than the pre-rewrite structure

## Workstream 6: Test Infrastructure Cleanup

### Goal

Consolidate repeated TTY/stdout override helpers used by runner tests.

### Scope

- move duplicated helpers into `tests/helpers/`
- update runner tests to use them

### Why this is in scope

This is not core architecture, but the duplication is already real and a
rewrite touching runner tests should clean it up.

### Verification loop

After this milestone:

- runner test behavior is unchanged

Commands:

```bash
pnpm run test -- tests/cli/run-usage-report.test.ts tests/cli/run-efficiency-report.test.ts tests/cli/run-efficiency-report-overflow.test.ts tests/cli/run-optimize-report.test.ts
```

## Sequencing

Recommended order:

1. Report definition registry
2. Shared runner lifecycle
3. Generic table metadata decoupling
4. Aggregation profiles
5. Docs generator convergence
6. Test infrastructure cleanup
7. Implement `trends`

Do not start `trends` in parallel with this rewrite. The point is to land
`trends` onto the rewritten seams, not to reconcile two moving targets.

## Risks

### Risk: over-abstracting

Mitigation:

- keep report-specific builders/renderers intact
- extract only proven common lifecycle and metadata concerns
- no inheritance trees

### Risk: behavior drift in CLI help/docs

Mitigation:

- preserve help snapshots/functionality through focused tests
- regenerate and inspect CLI docs after the metadata convergence step

### Risk: hidden regressions in stdout/stderr behavior

Mitigation:

- keep runner tests focused on stdout/stderr routing
- avoid changing log strings unless explicitly required

### Risk: too much rewrite before value delivery

Mitigation:

- verification loop after each workstream
- stop the rewrite once the target seams are in place for `trends`

## Validation checklist

Core:

- [ ] `pnpm run lint`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`
- [ ] `pnpm run format:check`

Docs:

- [ ] `pnpm run site:docs:generate`
- [ ] `pnpm run site:check`
- [ ] architecture docs updated to match the rewritten module layout

Behavior:

- [ ] command names/arguments unchanged
- [ ] help text stable for existing commands
- [ ] command ordering and option ordering stable for existing commands
- [ ] stdout/stderr routing unchanged
- [ ] share filenames/log strings unchanged
- [ ] optimize/efficiency no longer fabricate fake `UsageReportRow` values for
      table rendering
- [ ] non-usage reports can aggregate without model breakdown computation

## Exit criteria

This rewrite is done when:

1. existing reports run through the shared architecture
2. command/report metadata has one canonical source
3. table rendering is no longer coupled to usage-domain row types for
   optimize/efficiency
4. aggregation supports no-model-breakdown mode
5. architecture docs and generated CLI docs reflect the new structure
6. `docs/ai/trends-plan.md` has been reconciled to the rewritten structure
7. `trends` can be added without introducing new CLI/report plumbing

## Verdict

Given the stated preference to avoid plumbing and weak architecture, this broad
rewrite is justified **before** `trends`.

It is a real project, not an MVP. The right move is to fix the report-command
foundation now, then add `trends` to the cleaned-up architecture.
