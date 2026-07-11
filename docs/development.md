# Development Guide

## Requirements

- Node.js 24+
- pnpm (used for local scripts and lockfile)

## Install

```bash
pnpm install
```

## Local quality checks

Minimum project checks:

```bash
pnpm run verify
```

`pnpm run test` includes coverage by default; the coverage-threshold gate then enforces the global and per-file floors that CI enforces.

Toolchain note: `pnpm run typecheck` runs `tsc --noEmit` through the native TypeScript 7 compiler (the `@typescript/native` devDependency, aliased to `npm:typescript@7.0.2`). The package named `typescript` is aliased to `npm:@typescript/typescript6@6.0.2` so typescript-eslint keeps resolving a TS6-named API until upstream supports the TS 7 API.

## CI-parity validation

The GitHub Actions workflow does more than the four core checks above. Before opening a PR, run the relevant subset for the area you changed. For a full CI-parity pass, use:

```bash
pnpm run verify:ci
```

Notes:

- CI installs with `pnpm install --frozen-lockfile`.
- The main test job rebuilds `dist` before `pnpm run smoke:dist-opencode` and `pnpm run test`.
- Site CI also regenerates `site/src/content/docs/cli-reference.mdx` and `site/src/content/docs/security.mdx` and fails if either generated file is out of date.

## Security and dependency hygiene

See [Security Guide](./security.md) for the current repo controls and contributor expectations.
Highlights:

- direct dependencies are pinned to exact versions and `.npmrc` enforces `save-exact=true`
- the committed `pnpm-lock.yaml` is the effective dependency pin for installs
- lockfile entries include `integrity: sha512-...` hashes
- GitHub Actions are pinned to full commit SHAs
- Dependabot manages npm and GitHub Actions update PRs
- security scanning includes `pnpm audit`, Dependency Review on PRs, and CodeQL
- npm publishing uses OIDC trusted publishing

## Reporting pipeline performance baseline

Capture local timing snapshots for daily/weekly/monthly report generation and efficiency reporting on representative fixtures:

```bash
pnpm run perf:report-baseline
```

The command runs a warmup + sampled timings and prints min/avg/p95/max per scenario.
It includes an ephemeral Git fixture repository for the `efficiency` scenario.
Use it to track report runtime over time while iterating locally.

## Production benchmark comparison

Compare production runtime against `ccusage` on your machine. The script times the built `dist/index.js`, so build first:

```bash
pnpm run build
npx -y ccusage@latest --version
CCUSAGE_BIN=$(find ~/.npm/_npx -name ccusage -path '*/.bin/*' | head -1)

# one scenario at a time
node scripts/perf-production-benchmark.mjs --runs 5 --scenario codex --ccusage-bin "$CCUSAGE_BIN"
node scripts/perf-production-benchmark.mjs --runs 5 --scenario claude --ccusage-bin "$CCUSAGE_BIN"

# or both scenarios in one run
node scripts/perf-production-benchmark.mjs --runs 5 --scenario all --ccusage-bin "$CCUSAGE_BIN"
```

Optional artifact outputs:

```bash
node scripts/perf-production-benchmark.mjs \
  --runs 5 \
  --scenario codex \
  --ccusage-bin "$CCUSAGE_BIN" \
  --json-output ./tmp/production-benchmark-codex.json \
  --markdown-output ./tmp/production-benchmark-codex.md
```

## Runtime configuration in development

The CLI reads per-run seams from environment variables (no `.env` auto-loading in runtime). Persistent tuning lives in `config.toml`.

Common variables:

- `LLM_USAGE_SKIP_UPDATE_CHECK=1`
- `LLM_USAGE_UPDATE_CACHE_SCOPE=session`
- `LLM_USAGE_UPDATE_CACHE_SESSION_KEY=...`
- `LLM_USAGE_PARSE_WORKERS=...`
- `LLM_USAGE_PARSE_WORKER_MIN_BYTES=...`
- `LLM_USAGE_EVENT_STORE=0` disables the default-on SQLite event store
- `LLM_USAGE_EVENT_STORE_PATH=...`
- `LLM_USAGE_PROFILE_RUNTIME=1` enables runtime profiling diagnostics on `stderr` (default: unset/disabled)

## Build and packaging

Build CLI bundle:

```bash
pnpm run build
```

Smoke-test built OpenCode path:

```bash
pnpm run smoke:dist-opencode
```

Check npm package output:

```bash
pnpm run pack:check
```

## Test layout

- Unit tests: `tests/**`
- Fixture-based parser tests: `tests/fixtures/**`
- End-to-end report tests: `tests/e2e/**`

## CI

Workflow file: `.github/workflows/ci.yml`

CI runs on pull requests and pushes to `main` and `master`.

Checks:

- install (`pnpm install --frozen-lockfile`)
- lint
- typecheck
- format check
- build
- built dist OpenCode smoke test
- npm pack check
- test + coverage (`pnpm run test`, Node 24)
- coverage threshold gate (`node .github/scripts/check-coverage-threshold.mjs`)

Runtime:

- Node 24

Coverage summary/artifacts are generated from the single Node 24 CI run.

## Release process

### Local commands

- `pnpm run release:dry` to preview the next release
- `pnpm run release` to run an interactive release locally
- `pnpm run release:ci --increment patch|minor|major` for non-interactive mode

Release configuration lives in `.release-it.json`.

For trusted publishing, `npm.skipChecks` is enabled because release-it's normal npm auth checks are not compatible with OIDC-only publishing.

During release, `release-it` runs `pnpm run site:docs:generate` in an `after:bump` hook, so the release commit automatically includes updated generated site docs such as `site/src/content/docs/cli-reference.mdx` and `site/src/content/docs/security.mdx`.

### GitHub workflow

Workflow file: `.github/workflows/release.yml`

The release workflow is manual (`workflow_dispatch`) and asks for:

- increment type (`patch`, `minor`, `major`)
- dry-run flag

The workflow uses Node `24` and upgrades npm to `11.5.1+`, which is required for trusted publishing.

### Required repository configuration

This project is configured for npm **trusted publishing (OIDC)**, so no npm publish token is required.

Before running a real release from GitHub Actions, configure these:

1. **Add Trusted Publisher on npmjs.com** for this package
   - Provider: GitHub Actions
   - Organization/user: your GitHub owner
   - Repository: this repository name
   - Workflow filename: `release.yml`
2. **npm package access**
   - make sure package name is available and you have publish rights
3. **GitHub token permissions**
   - repository Actions permissions should allow creating tags/releases
4. **GitHub-hosted runner only**
   - trusted publishing does not currently support self-hosted runners

Optional but recommended:

- in npm package settings, require 2FA and disallow token publishing once OIDC is verified
- protect `main`/`master` and release only from reviewed commits
- keep Conventional Commit style so changelog output stays clean

## Adding a new source adapter

1. Create `src/sources/<name>/<name>-source-adapter.ts`
2. Implement `SourceAdapter`
   - required: `discoverFiles()` and `parseFile(filePath)`
   - optional: `parseFileWithDiagnostics(filePath)` when you need per-file skipped-row counters
   - optional: `getParseDependencies(filePath)` when parsing reads sidecar files (the event store fingerprints them)
   - for JSONL sources, consider `readJsonlObjects(filePath, { shouldParseLine })` — or the faster byte-level `shouldParseLineBytes` — to skip irrelevant lines before `JSON.parse`
3. Normalize output through `createUsageEvent`
4. Add fixture tests under `tests/sources`
5. Add one entry to `sourceRegistrations` in `src/sources/create-default-adapters.ts`
   (id, storage format, `supportsSourceDir`, the dedicated `option` metadata
   `{ key, flag, help }`, and the constructor). That single entry drives the
   dedicated `--<source>-dir`/`--<source>-db` flag and its help text, the
   `--source-dir` participation (directory-backed) or rejection (db-backed), the
   explicit-source detection in `resolveExplicitSourceIds`, blank-path validation,
   and the config `sourceDirs.<id>` → option-key mapping. Add the id to
   `dedicatedOptionOrderIds` only if you need it to appear in a specific `--help`
   position (the default is registration order).
6. Wire the config surface (each mirror is guarded by a manifest parity test that
   fails if it drifts):
   - add the source id to `USER_CONFIG_SOURCE_DIR_KEYS` in `src/config/user-config.ts`
     (the `config init` template derives its `[sourceDirs]` entries from that list)
     and to `sourceDirOptionByConfigKey` in `src/cli/apply-user-config.ts`
   - add the matching `sourceDirs.<id>` property to `schema/config.schema.json` AND
     the published copy `site/public/config-schema.json` — unit tests fail if either
     copy drifts from the loader's known keys
7. Update the docs surface:
   - README Supported Sources table and source-list examples
   - the site landing page (`site/src/content/docs/index.mdx`): source count and sources table
   - a `site/src/content/docs/sources/<id>.mdx` page plus its Data Sources sidebar entry in `site/astro.config.mjs`
8. Extend the e2e expectations: fixtures under `tests/fixtures/e2e/<id>/` and the all-sources list plus totals in `tests/e2e/multi-source.e2e.test.ts`
9. Verify CLI filtering with `--source <name>`

Keep parsing logic isolated to the adapter. Do not spread source-specific assumptions across aggregation or rendering.
