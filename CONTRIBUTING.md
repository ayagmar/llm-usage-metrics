# Contributing

Thanks for contributing.

## Development setup

Requirements:

- Node.js 24.21.0 for development (the CLI supports Node.js 22.16+ or 24+)
- pnpm

Recommended setup with `nvm`:

```bash
nvm use
```

The repository includes a root `.nvmrc` pinned to the Node version used in CI.

Install dependencies:

```bash
pnpm install
```

Run checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
```

## Project shape

Main directories:

- `src/cli`: command wiring and report orchestration
- `packages/core/src/sources`: source adapters (`pi`, `codex`, etc.), in the `@ayagmar/agent-sessions` package
- `src/domain`: normalized event/report types
- `src/pricing`: pricing loaders + cost engine
- `src/persistence`: SQLite event store, migrations, and departed-file history
- `src/machines`: other machines' usage: `machine export`, ssh sync, and per-machine caches
- `src/aggregate`: period aggregation
- `src/render`: terminal, Markdown, JSON, and share-card output
- `tests`: unit, fixture, and e2e tests

More detail: `docs/architecture.md`.

## Contribution style

- Keep functions small and explicit.
- Prefer data normalization at boundaries (adapters/domain constructors).
- Avoid hidden behavior and broad implicit defaults.
- Add or update tests with every functional change.

## Adding a new source (Claude, Gemini, etc.)

The codebase supports this through `SourceAdapter`.

### 1) Create an adapter

Add `packages/core/src/sources/<name>/<name>-source-adapter.ts`, exported from
`packages/core/src/sources/<name>/index.ts` and a `./sources/<name>` entry in
`packages/core/package.json`, implementing:

- `id`
- `discoverFiles()`
- `read(filePath, options)`: an `async function*` that yields the file's events in order and records skipped rows in `options.diagnostics`
- `parserVersion`: bump it when unchanged input would parse differently, so the parse cache drops events stored by the old parser
- `getParseDependencies(filePath)`, when the result depends on other files (sidecars, a parent transcript): return their paths so a change to them reparses the file

Normalize raw data with `createUsageEvent` so downstream code receives consistent `UsageEvent` values.

### 2) Wire it into reporting

Add one entry to `sourceRegistrations` in `packages/core/src/registry/adapters.ts`. That entry
drives `getDefaultSourceIds()` (and so `--source` filtering and the docs sidebar) and, for
directory-backed sources, the generic `--source-dir <source-id=path>` override. Then add the
dedicated `--<source>-dir`/`--<source>-db` flag to `sourceCliOptions` and `dedicatedOptionOrderIds`
in `src/cli/source-cli-options.ts`, which keeps every flag name and help text out of
the adapters. Adapters resolve their default paths from the `SourceContext` they are given when
constructed; never read `os.homedir()`, `process.env` or `process.platform` at module load. Then
add the config key and docs (see
`docs/development.md`, "Adding a new source adapter"), plus CLI examples:

```bash
llm-usage daily --source-dir <new-source-id>=/path/to/sessions
```

For file/DB-backed sources, add only a dedicated flag (for example `--opencode-db`); `--source-dir` rejects them with an actionable error.

### 3) Add tests

- fixture-based parser tests in `packages/core/tests/sources/<name>` (fixtures in `packages/core/tests/fixtures/<name>`)
- integration coverage if CLI behavior changes

### 4) Verify source filter behavior

`--source` filtering is source-id based and case-insensitive. Confirm the new source id is filterable:

```bash
llm-usage daily --source <new-source-id>
```

## Adding/changing pricing behavior

- Implement or adjust a `PricingSource` in `src/pricing`.
- Keep explicit cost untouched.
- Keep estimation logic deterministic.
- Add tests for missing pricing, aliasing, and edge values.

## Security and dependency changes

When changing dependencies, workflows, or release configuration:

- verify the target version from an authoritative source first
- keep the change narrow and intentional
- run `pnpm install` and commit the matching `pnpm-lock.yaml` changes
- review the lockfile diff and confirm only intended packages changed
- preserve lockfile `integrity: sha512-...` entries
- preserve `pnpm install --frozen-lockfile` in workflows
- keep GitHub Actions pinned to full commit SHAs
- keep the trailing release comments on action refs (for example `# v4.3.1`) so Dependabot can update them cleanly
- keep direct dependency versions exact in `package.json` files
- run `pnpm audit --audit-level=moderate` when changing dependencies

See [docs/security.md](./docs/security.md) for the full security guide.

## Commit guidance

Use concise Conventional Commit subjects, for example:

- `fix(cli): validate source filter input`
- `feat(source): add gemini session adapter`
- `docs(project): expand adapter contribution guide`

## Before opening a PR

Run the full check suite:

```bash
pnpm run verify
```

Then:

- Review the full diff with fresh eyes, or have someone (or a review agent) do it, before pushing.
- Keep the PR to one concern.
- If the change touches pricing, check `tests/pricing/model-resolution-reference.test.ts`. Update any row whose resolution moves, and only on purpose.
- If an adapter's output changes, bump its `parserVersion` (see `AGENTS.md`, Correctness Guardrails).
