# Development Guide

## Requirements

- Node.js 20+
- Bun (used for local scripts and lockfile)

## Install

```bash
bun install
```

## Local quality checks

Run these before opening a PR:

```bash
bun run lint
bun run typecheck
bun run test
bun run format:check
```

`bun run test` includes coverage by default.

## Runtime configuration in development

The CLI reads runtime knobs directly from environment variables (no `.env` auto-loading in runtime).

Common variables:

- `LLM_USAGE_SKIP_UPDATE_CHECK=1`
- `LLM_USAGE_UPDATE_CACHE_TTL_MS=...`
- `LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS=...`
- `LLM_USAGE_PRICING_CACHE_TTL_MS=...`
- `LLM_USAGE_PRICING_FETCH_TIMEOUT_MS=...`
- `LLM_USAGE_PARSE_MAX_PARALLEL=...`

## Build and packaging

Build CLI bundle:

```bash
bun run build
```

Check npm package output:

```bash
bun run pack:check
```

## Test layout

- Unit tests: `tests/**`
- Fixture-based parser tests: `tests/fixtures/**`
- End-to-end report tests: `tests/e2e/**`

## CI

Workflow file: `.github/workflows/ci.yml`

CI runs on pull requests and pushes to `main` and `master`.

Checks:

- install (`bun install --frozen-lockfile`)
- lint
- typecheck
- format check
- build
- npm pack check
- test + coverage (`bun run test`, Node 22 only)

Matrix:

- Node 20
- Node 22

To avoid duplicate execution, tests run once (Node 22) and publish coverage summary/artifacts from that single run.

## Release process

### Local commands

- `bun run release:dry` to preview the next release
- `bun run release` to run an interactive release locally
- `bun run release:ci -- --increment patch|minor|major` for non-interactive mode

Release configuration lives in `.release-it.json`.

For trusted publishing, `npm.skipChecks` is enabled because release-it's normal npm auth checks are not compatible with OIDC-only publishing.

### GitHub workflow

Workflow file: `.github/workflows/release.yml`

The release workflow is manual (`workflow_dispatch`) and asks for:

- increment type (`patch`, `minor`, `major`)
- dry-run flag

The workflow pins Node `22.14.0+` and upgrades npm to `11.5.1+`, which is required for trusted publishing.

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
3. Normalize output through `createUsageEvent`
4. Add fixture tests under `tests/sources`
5. Wire into CLI report pipeline if needed

Keep parsing logic isolated to the adapter. Do not spread source-specific assumptions across aggregation or rendering.
