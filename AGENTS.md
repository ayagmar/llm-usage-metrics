# AGENTS.md

## Purpose

Guidance for coding agents working in this repository.

## Project Snapshot

- Type: TypeScript CLI (`llm-usage-metrics`)
- Runtime: Node.js 22.16+ or 24+, not 23 (develop on 24, see `.nvmrc`); the built CLI also runs on Bun 1.4+ (CI smoke: `pnpm run smoke:dist-bun`)
- Package/dev workflow: pnpm (`pnpm-lock.yaml`)
- Core job: parse local usage data, normalize events, apply pricing, aggregate, render reports

## Setup and Commands

- Install: `pnpm install`
- Lint: `pnpm run lint`
- Typecheck: `pnpm run typecheck`
- Tests (with coverage): `pnpm run test`
- Format check: `pnpm run format:check`
- Build: `pnpm run build`
- Standard verification: `pnpm run verify`
- Full CI-parity verification: `pnpm run verify:ci`

Before opening a PR:

1. Run `pnpm run verify`.
2. Get an independent review of the full diff (`/code-review`, or a reviewer subagent with
   no stake in the change), and fix the findings before pushing.
3. Keep the PR to one concern; split cache, source, pricing, and dependency changes.

## Architecture Boundaries

- `src/cli`: command wiring and report orchestration
- `packages/core/src/sources`: source adapters + discovery/parsing (package `@ayagmar/agent-sessions`; registry in `packages/core/src/registry`)
- `src/domain`: normalized data contracts
- `packages/core/src/pricing`: pricing source + cost engine (`src/pricing` only adds the CLI's cache path and `fetch`)
- `src/aggregate`: usage bucketing/totals
- `src/render`: terminal/markdown/json output formatting
- `src/update`: startup update notifier
- `src/config`: runtime override/env-var resolution
- `src/utils`: shared fs/discovery/time/logging helpers

Keep source-specific parsing logic inside adapters. Keep pricing logic in `packages/core/src/pricing`. Keep rendering concerns in `src/render`.

## Coding Style

- Follow strict TypeScript and existing ESLint rules.
- Use type imports where possible.
- Do not introduce `any`.
- Prefer small, explicit functions over implicit behavior.
- Normalize data at boundaries (adapter/domain constructors).
- Preserve deterministic output ordering.
- Avoid inline dynamic imports.
- Before adding a helper, search `src/` and `packages/core/src` for one that already does it. The share client imports the `src/render` and `src/utils` helpers it needs instead of copying them.

## Correctness Guardrails

- Parse cache: an adapter's events for a file must depend only on that file, the paths it
  returns from `getParseDependencies`, and its `parserVersion`. Bump `parserVersion` when
  unchanged input would parse differently, and declare as a dependency anything else that
  changes the result (sidecar files, a parent transcript, a decision based on adapter
  roots). Otherwise stored events go stale silently.
- Token semantics: `inputTokens` excludes cache reads (use `splitPromptIncludingCachedTokens`
  for prompt counts that include them), and `outputTokens` includes reasoning, with
  `reasoningTokens` as a breakdown. When `reasoningTokens > 0`, pass `totalTokens`
  explicitly: `createUsageEvent` adds reasoning to a computed total. Check new sources
  against real logs, not only fixtures.
- Pricing: `packages/core/tests/pricing/model-resolution-reference.test.ts` pins how real model names
  resolve. When the matcher, model map, or snapshot changes, review every moved row and
  update it deliberately. A snapshot refresh lists models removed upstream; review that
  list, since those prices move to `litellm-retired-pricing.json` unless a live key
  already resolves the name to the same rates. Those pruned prices go to
  `tests/fixtures/pricing/pruned-retired-pricing.json`, which the next refresh reads
  back: review and commit it with the snapshot.
- Regexes: lint runs ReDoS checks (`eslint-plugin-regexp` everywhere; `eslint-plugin-redos`
  on regex literals in `src/`, not `new RegExp(...)`). Do not run lazy or greedy wildcards
  over large untrusted text; scan with `indexOf` instead.
- When a shared helper serves several callers (e.g. history and prune), check the change
  against each caller's semantics.

## Static Checks (ast-grep)

`pnpm run lint` runs ESLint, then `pnpm run lint:ast-grep`: `ast-grep test` over
`rule-tests/`, then `ast-grep scan` with the rules in `rules/ast-grep/` (config:
`sgconfig.yml`). Each rule's `files` list sets its scope within `src/`, `packages/core/src`
and `scripts/`.

Error rules fail lint. Each one keeps a fact in one owner module:

- `active-time-owner`: `IDLE_GAP_CAP_MS` in a comparison or `Math.min`/`Math.max`, or a
  5-minute literal compared with a gap or idle value or stored under an idle/gap name.
  Decide gaps with `getActiveGapMs` or `computeActiveIntervals`
  (`packages/core/src/domain/active-time.ts`). Importing the constant and display
  arithmetic such as `IDLE_GAP_CAP_MS / MINUTE_MS` are fine.
- `token-sum-owner`: `+=` or `x = x + y` on `inputTokens`, `outputTokens`,
  `reasoningTokens`, `cacheReadTokens` or `cacheWriteTokens`. A lone `totalTokens` counter
  is fine. Use `src/aggregate/usage-totals.ts`. Scope: `src/`, `scripts/`.
- `cost-incomplete-owner`: `x.costIncomplete = true`, `x.costIncomplete ||= ...` and
  `a.costIncomplete || b.costIncomplete`. Use `mergeCostIncomplete`,
  `eitherCostIncomplete` or the `add*` helpers in `src/aggregate/usage-totals.ts`. Scope:
  `src/`, `scripts/`.
- `local-number-coercion`: a function or `const` named like one of the coercers in
  `packages/core/src/sources/parsing-utils.ts`.
- `local-record-guard`: a function or `const` named `isRecord` or `asRecord` outside
  `packages/core/src/utils/as-record.ts`.
- `jsonl-stem-owner`: `basename(x, '.jsonl')`, the stem sources fall back to as a session
  id. Use `getJsonlFileStem` (`packages/core/src/sources/parsing-utils.ts`). Scope:
  `packages/core/src`.
- `first-timestamp-owner`: a `for...of` loop that passes its loop variable (or `record[key]`)
  to `normalizeTimestampCandidate`. Use `firstTimestamp`
  (`packages/core/src/sources/parsing-utils.ts`). Scope: `packages/core/src`.
- `time-constants-owner`: a declaration named `SECOND_MS`, `MINUTE_MS`, `HOUR_MS` or
  `DAY_MS`, and hand-written conversions: `n * 60 * 1000`, multiplying or dividing by
  `60_000`, `3_600_000` or `86_400_000`. Bare timeouts such as `60_000` are fine. Use
  `src/utils/time-constants.ts`. Scope: `src/`, `scripts/`.
- `file-lock-owner`: `open`/`openSync` (any qualifier, such as `fs.promises.open`) with the
  `'wx'` flag. Use `acquireFileLock` from `src/utils/file-lock.ts`. `writeFile` with
  `flag: 'wx'` is not a lock and is not flagged.

The owners of `token-sum-owner`, `cost-incomplete-owner` and `time-constants-owner` live in
`src/`, which `packages/core/src` cannot import, so those rules leave core alone.

Warning rules print but never fail: `unbounded-push-spread` (`push(...array)` on input that
can pass about 125k items; use `appendAll` from `packages/core/src/utils/append-all.ts`, and
leave small bounded spreads such as warning lists alone) and `injected-clock-default` (`deps.now?.() ?? new Date()`
repeated per command). Numeric and tuple `sort()` without a comparator is an ESLint error
(`@typescript-eslint/require-array-sort-compare`).

- To add a rule, put `<id>.yml` in `rules/ast-grep/` and `rule-tests/<id>-test.yml` with at
  least one `valid` and one `invalid` case, plus each false positive you had to tighten the
  rule against. Do not use `constraints` inside an `any` of patterns: ast-grep checks them
  after `any` has picked its first structural match, so later branches never run. Check
  child fields with `has: { field: ..., regex: ... }` instead.
- Exempt the owner module, and a file that cannot import it (a script run by plain `node`),
  in the rule's `ignores` list, with a comment giving the reason.
- To suppress one hit, put `// ast-grep-ignore: <rule-id>` on the line above it, with a
  comment saying why. Use it only for a one-off where the owner does not fit. If you need it
  more than once for the same reason, tighten the rule instead.

## CLI and Output Rules

- Keep option semantics aligned with `site/src/content/docs/cli-reference.mdx` (generated by `scripts/generate-cli-reference.mjs` — regenerate via `pnpm run site:docs:generate`, do not hand-edit).
- Validate inputs early and fail with actionable errors.
- Keep report output data-only on `stdout` (especially `--json`/`--markdown`).
- Emit diagnostics to `stderr`.

## Testing Expectations

- Every functional change should include or update tests.
- Place tests by area:
  - `tests/cli`
  - `packages/core/tests/sources`
  - `packages/core/tests/pricing`
  - `tests/render`
  - `tests/e2e`
- For new sources, add fixture-based parser tests and adapter wiring tests.

## Documentation Updates

Update docs when behavior changes:

- `README.md` for user-facing behavior/examples
- `site/src/content/docs/cli-reference.mdx` for option semantics (generated by `scripts/generate-cli-reference.mjs` — regenerate via `pnpm run site:docs:generate`, do not hand-edit)
- `docs/architecture.md` when layering or flow changes
- `site/src/content/docs/library/` and `packages/core/README.md` when the `@ayagmar/agent-sessions` public API changes
- `site/src/assets/screenshots/` and `site/public/demo/report.html` (regenerate via `pnpm run build && pnpm run docs:screenshots`) when terminal or share report output changes visibly

## Commit and PR Guidance

- Use concise Conventional Commit subjects (e.g. `fix(cli): ...`, `feat(source): ...`).
- Keep commits focused and isolated by concern.
- Include a short validation summary in PR descriptions.
