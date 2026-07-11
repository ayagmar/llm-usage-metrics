# Idea #8: E2E multi-source fixture harness

> Confidence: **75%** — real value, medium-large scope. Shipped on
> `feat/improvements` (2026-07): a committed multi-source fixture tree now
> lives under `tests/e2e/` alongside the harness that drives it.

## The problem this solves

There are e2e tests today (`tests/e2e/`: `usage-report`, `trends`, `opencode`,
`large-jsonl`), and `usage-report` already covers a mixed pi + codex run and
openclaw. But there is no test that runs the **real built CLI binary** against
a **committed, multi-source fixture tree** (pi + codex + gemini + droid +
opencode + openclaw + claude together) and asserts the end-to-end output.

This matters because the riskiest regressions are **cross-source**:

- adapter registration order + `getDefaultSourceIds()` stability
- `--source` filtering across all sources at once
- `--provider` pruning interacting with `fixedProviderRoots` (codex/openai,
  gemini/google) alongside provider-less sources (pi/droid/claude)
- `--source-dir` generic overrides mixed with dedicated `--*-dir` flags
- pricing applied across a mixed model set in one pass

Each of these is currently covered only by **unit tests with hand-rolled fake
adapters**, not by the real adapter stack through the real CLI.

## The idea

A single committed fixture tree under `tests/e2e/fixtures/multi-source/` that
mimics a real `$HOME` layout, plus a harness that:

1. builds the CLI (`pnpm run build`)
2. points the binary at the fixture tree via the `--*-dir` flags
3. runs a matrix of commands (`daily`, `monthly`, `trends`, `efficiency`,
   `optimize`) and output modes (`--json`, `--markdown`, terminal)
4. snapshots the `--json` output (the data-only contract) and asserts on
   stable, meaningful fields

### Fixture layout

```
tests/e2e/fixtures/multi-source/
  pi/agent/sessions/2026-06-01.jsonl
  codex/sessions/2026-06-01.jsonl
  gemini/tmp/proj/chats/session.json
  factory/sessions/2026-06-01.settings.json
  opencode/opencode.db
  openclaw/agents/session.jsonl
  claude/projects/-proj/session.jsonl
```

Each fixture file is small (a handful of rows) but exercises the real parse
path of every adapter.

### Harness sketch

```ts
// tests/e2e/multi-source.e2e.test.ts
import { buildCli } from './helpers/build-cli.js';
import { fixtureRoot } from './helpers/fixtures.js';

for (const command of ['daily', 'monthly', 'trends'] as const) {
  it(`multi-source ${command} produces stable JSON`, async () => {
    const { stdout } = await buildCli([
      command, '--json',
      '--pi-dir', `${fixtureRoot}/pi/agent/sessions`,
      '--codex-dir', `${fixtureRoot}/codex/sessions`,
      '--gemini-dir', `${fixtureRoot}/gemini`,
      '--droid-dir', `${fixtureRoot}/factory/sessions`,
      '--opencode-db', `${fixtureRoot}/opencode/opencode.db`,
      '--source-dir', `openclaw=${fixtureRoot}/openclaw/agents`,
      '--claude-dir', `${fixtureRoot}/claude/projects`,
      '--pricing-offline',
      '--since', '2026-06-01', '--until', '2026-06-01',
    ]);

    const payload = JSON.parse(stdout);
    expect(payload.sources).toEqual(['pi','codex','gemini','droid','opencode','openclaw','claude']);
    // snapshot the stable shape, not volatile fields like absolute costs
    expect(stripVolatile(payload)).toMatchFileSnapshot(`./snapshots/${command}.json`);
  });
}
```

`stripVolatile` removes fields that depend on the machine (absolute paths,
timestamps from "now") so snapshots are stable across runs and machines.

## Why it is a good improvement

- **Catches cross-source regressions** that unit tests with fake adapters
  structurally cannot (e.g. a real adapter's provider/root metadata flowing
  through `--provider` pruning).
- **Locks the `--json` output contract** as a snapshot, so breaking changes to
  the machine-readable shape are caught in review, not by downstream consumers.
- **De-risks the bigger refactors** (event store, source additions) by giving
  them a single end-to-end safety net.

## Possible downsides

- **Snapshot maintenance.** File snapshots drift and can become "accept any
  change" noise if not curated. Mitigated by `stripVolatile` + reviewing diffs.
- **Build dependency.** The harness needs the built `dist/index.js`, so it is
  slower than unit tests and must run after `pnpm run build` (the existing e2e
  tests already do this).
- **Fixture drift from real formats.** Committed fixtures can age relative to
  real source formats; they need occasional refresh. This is unavoidable for
  any fixture-based parser test and the per-adapter unit tests already carry
  this cost.
- **Scope.** A thorough matrix (16 sources × 5 commands × 3 modes) is
  medium-large. A minimal v1 can be one command (`monthly --json`) across all
  16 sources and grow from there.

## Confidence

**75%.** The value is real and the gap (cross-source, real-binary e2e) is
genuine, but it is larger than the two ideas shipped in PR #119 and the existing
e2e coverage is not zero. Recommend a minimal v1 (one command, all 16
sources, JSON snapshot) before expanding the matrix.

## Suggested first step

Add `tests/e2e/fixtures/multi-source/` with one tiny file per source and a
single `multi-source.e2e.test.ts` that runs `monthly --json --pricing-offline`
over all 16 and snapshots the source list + per-source totals. This is the
smallest version that proves the harness and catches registration/order
regressions.
