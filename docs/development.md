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
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
```

`pnpm run test` includes coverage by default.

## CI-parity validation

The GitHub Actions workflow does more than the four core checks above. Before opening a PR, run the relevant subset for the area you changed. For a full CI-parity pass, use:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm run docs:mermaid:validate
pnpm run build
pnpm run smoke:dist-opencode
pnpm run pack:check
pnpm --filter llm-usage-metrics-site run format:check
pnpm run site:check
pnpm run site:docs:generate -- --rebuild
git diff --exit-code -- site/src/content/docs/cli-reference.mdx
pnpm run site:build
```

Notes:

- CI installs with `pnpm install --frozen-lockfile`.
- The main test job rebuilds `dist` before `pnpm run smoke:dist-opencode` and `pnpm run test`.
- Site CI also regenerates `site/src/content/docs/cli-reference.mdx` and fails if the generated file is out of date.

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

Compare production runtime against `ccusage-codex` on your machine:

```bash
# direct source-to-source parity
pnpm run perf:production-benchmark -- --runs 5 --llm-source codex

# multi-source for one provider
pnpm run perf:production-benchmark -- --runs 5 --llm-source pi,codex,gemini,opencode
```

Optional artifact outputs:

```bash
pnpm run perf:production-benchmark -- \
  --runs 5 \
  --llm-source codex \
  --json-output ./tmp/production-benchmark-openai-codex.json \
  --markdown-output ./tmp/production-benchmark-openai-codex.md

pnpm run perf:production-benchmark -- \
  --runs 5 \
  --llm-source pi,codex,gemini,opencode \
  --json-output ./tmp/production-benchmark-openai-multi-source.json \
  --markdown-output ./tmp/production-benchmark-openai-multi-source.md
```

## Runtime configuration in development

The CLI reads runtime knobs directly from environment variables (no `.env` auto-loading in runtime).

Common variables:

- `LLM_USAGE_SKIP_UPDATE_CHECK=1`
- `LLM_USAGE_UPDATE_CACHE_SCOPE=session`
- `LLM_USAGE_UPDATE_CACHE_SESSION_KEY=...`
- `LLM_USAGE_UPDATE_CACHE_TTL_MS=...`
- `LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS=...`
- `LLM_USAGE_PRICING_CACHE_TTL_MS=...`
- `LLM_USAGE_PRICING_FETCH_TIMEOUT_MS=...`
- `LLM_USAGE_PARSE_MAX_PARALLEL=...`
- `LLM_USAGE_PARSE_CACHE_ENABLED=...`
- `LLM_USAGE_PARSE_CACHE_TTL_MS=...`
- `LLM_USAGE_PARSE_CACHE_MAX_ENTRIES=...`
- `LLM_USAGE_PARSE_CACHE_MAX_BYTES=...`
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

During release, `release-it` runs `pnpm run site:docs:generate` in an `after:bump` hook, so the release commit automatically includes an updated `site/src/content/docs/cli-reference.mdx` (including the new version banner).

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
   - for JSONL sources, consider `readJsonlObjects(filePath, { shouldParseLine })` to skip irrelevant lines before `JSON.parse`
3. Normalize output through `createUsageEvent`
4. Add fixture tests under `tests/sources`
5. Register adapter in `src/sources/create-default-adapters.ts`
6. Wire source-specific override semantics:
   - directory-backed sources use `--source-dir <source-id=path>` (for example `pi`, `codex`, `gemini`, `droid`)
   - file/DB-backed sources use dedicated flags (for example `--opencode-db`)
7. Verify CLI filtering with `--source <name>`

Keep parsing logic isolated to the adapter. Do not spread source-specific assumptions across aggregation or rendering.
