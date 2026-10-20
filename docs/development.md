# Development Guide

## Requirements

- Node.js 24.21.0 for development (matches CI and `.nvmrc`); the CLI supports Node.js 22.16+ or 24+ (not 23), and Bun 1.4+
- pnpm 12.9.1 (used for local scripts and the lockfile)

## Install

```bash
pnpm install
```

## Repository layout

The repository is a pnpm workspace (`pnpm-workspace.yaml`) with three packages:

- the root package, `llm-usage-metrics`: the CLI in `src/`, its tests in `tests/`, report JSON Schemas in `schema/`, and build, smoke, benchmark and docs scripts in `scripts/`
- `packages/core`, `@ayagmar/agent-sessions`: the source adapters, event types, read stages and dedup that the CLI bundles; its tests and parser fixtures live in `packages/core/tests`
- `site`, `llm-usage-metrics-site`: the Astro Starlight docs site, with its own scripts in `site/scripts/`

Root scripts prefixed `core:` run the core package's scripts (`core:build`, `core:typecheck`, `core:lint`, `core:test`, `core:test:fast`, `core:test:memory`), and `core:pack:check` packs it (after `core:build`) and fails if the manifest gains a dependency, an `exports` target is missing from the tarball, or a subpath does not load on its own. Scripts prefixed `site:` run the site's.

## Local quality checks

Minimum project checks:

```bash
pnpm run verify
```

`pnpm run test` includes coverage by default; the coverage-threshold gate then enforces the global and per-file floors that CI enforces.

Faster loops while iterating:

- `pnpm run test:fast [path]` — one-shot run with coverage off; pass any vitest filter (`pnpm run test:fast tests/render/`).
- `pnpm run test:watch` — watch mode with coverage off.
- `pnpm run verify:full` — `build` followed by `verify`, so the built-binary e2e (`tests/e2e/dist-cli.e2e.test.ts`) actually runs instead of skipping. Without a `dist/` build that suite skips itself and prints a one-line warning.

The `test` and `verify` scripts themselves are the unchanged CI gates — use them before committing.

Toolchain note: `pnpm run typecheck` runs `tsc --noEmit` through the native TypeScript 7 compiler (the `@typescript/native` devDependency, aliased to `npm:typescript@7.0.2`). The package named `typescript` is aliased to `npm:@typescript/typescript6@6.0.2` so typescript-eslint keeps resolving a TS6-named API until upstream supports the TS 7 API. The docs site stays on TypeScript 6: `astro check` refuses TypeScript 7.0, and its successor (`@astrojs/ts-content-mapper`) needs 7.1+, so `.github/dependabot.yml` ignores `typescript` 7+ in both npm jobs (the root job also updates the site through the pnpm workspace) until that settles. The rule does not cover `@typescript/native`, but Dependabot skips `npm:` aliases altogether, so update that compiler alias by hand.

## CI-parity validation

The GitHub Actions workflow does more than the four core checks above. Before opening a PR, run the relevant subset for the area you changed. For a full CI-parity pass, use:

```bash
pnpm run verify:ci
```

Notes:

- CI installs with `pnpm install --frozen-lockfile`.
- The main test job rebuilds `dist` before `pnpm run smoke:dist-opencode` and `pnpm run test`.
- The Bun job builds `dist` with Node, then runs `pnpm run smoke:dist-bun` and the OpenCode smoke under Bun. The Bun smoke check fails unless `node:sqlite` works under Bun, Bun's report JSON matches Node's on a cold run whose Codex files parse in worker threads (no fallback) and on a warm run served from the event store, and `statusline` prints one line.
- Site CI also regenerates `site/src/content/docs/cli-reference.mdx` and `site/src/content/docs/security.mdx` and fails if either generated file is out of date.
- `verify:ci` also runs the site format check, `site:check`, `site:build` and `site:links`.

## Share report client

The `--share` HTML report inlines a browser client from `src/share-report/client`. The CLI build does not compile it: `scripts/build-share-client.mjs` bundles it with esbuild into `src/share-report/client-bundle.generated.ts`, together with the CSP hashes of those exact bytes. After any change under `src/share-report/client`, rebuild and commit the generated file:

```bash
node scripts/build-share-client.mjs
```

`tests/share-report/client-bundle.test.ts` fails while the committed file is stale, and `pnpm run typecheck` checks the client against its own `tsconfig.json`.

## Docs site

The site lives in `site/`. Pages are MDX under `site/src/content/docs/`; the sidebar is `site/src/sidebar.mjs`.

```bash
pnpm run site:dev              # local server
pnpm run site:docs:generate    # regenerate cli-reference.mdx and security.mdx
pnpm run site:check            # astro check
pnpm run site:build            # build into site/dist
pnpm run site:links            # check internal links and #fragments in site/dist
pnpm run docs:mermaid:validate # Mermaid blocks in docs/*.md
```

`cli-reference.mdx` is generated from the CLI's report definitions and help by `scripts/generate-cli-reference.mjs`, and `security.mdx` from `docs/security.md`; never edit either by hand. `site:links` reads the built site, so run `site:build` first; it lists each broken internal link as `page → target` and exits 1.

Screenshots and the landing page's demo report come from synthetic data:

```bash
pnpm run build
pnpm run docs:screenshots
```

`site/scripts/docs-screenshots.mjs` writes demo logs for several sources into a temp directory (`site/scripts/demo-data.mjs`, seeded, about 90 days ending today), runs the built CLI against them with a temp HOME, offline pricing and `--no-sync`, and writes webp images to `site/src/assets/screenshots/` and the interactive report to `site/public/demo/report.html`. It drives headless Chromium through `playwright-core`: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a Chromium or chrome-headless-shell binary, or install the one `playwright-core` expects with `pnpm --filter llm-usage-metrics-site exec playwright-core install chromium`. Commit the regenerated images; they are not byte-identical between runs.

## Security and dependency hygiene

See [Security Guide](./security.md) for the current repo controls and contributor expectations.
Highlights:

- direct dependencies are pinned to exact versions and `pnpm-workspace.yaml` sets `saveExact: true`
- dependency build scripts are allowlisted in `pnpm-workspace.yaml`; only `esbuild` and `sharp` may run them
- the committed `pnpm-lock.yaml` is the effective dependency pin for installs
- lockfile entries include `integrity: sha512-...` hashes
- GitHub Actions are pinned to full commit SHAs and repository settings enforce SHA pinning
- Dependabot manages npm and GitHub Actions update PRs
- security scanning includes `pnpm audit`, Dependency Review on PRs, and CodeQL
- npm publishing uses OIDC trusted publishing
- non-release checkouts do not persist credentials, and workflow permissions default to read-only contents

## Reporting pipeline performance baseline

Capture local timing snapshots for daily/weekly/monthly report generation and efficiency reporting on representative fixtures:

```bash
pnpm run perf:report-baseline
```

The command runs a warmup + sampled timings and prints min/avg/p95/max per scenario.
It includes an ephemeral Git fixture repository for the `efficiency` scenario.
Use it to track report runtime over time while iterating locally.

## Speed check on pull requests

The `Speed Check` workflow builds the PR and its base branch, then times both CLIs on a
generated claude/codex/pi corpus (about 170k events, the newest a minute old): `daily` without the event store,
`daily` with a warm store, and `statusline` with a warm store. The two builds run
alternately, run by run, with separate config, cache, and data homes. Each build's untimed
first run must show the work (usage from every source in `daily`, nonzero usage in `statusline`),
so a build that skips it fails instead of looking fast; differing figures between the two
builds are noted in the summary. The check fails when a PR median is slower than the base
median by more than 15% and 30 ms; the job summary shows the table. Run the same comparison locally against any two builds:

```bash
node scripts/perf-regression-check.mjs --base ../base/dist/index.js --head dist/index.js
```

Shared runners are noisy, so a borderline failure can be re-run; a real regression repeats.

## Production benchmark comparison

Compare production runtime against `ccusage` on your machine. The script times the built `dist/index.js`, so build first:

```bash
pnpm run build
CCUSAGE_BIN=$(npx --yes --package=ccusage@20.0.37 sh -c 'command -v ccusage')
"$CCUSAGE_BIN" --version

# one scenario at a time
node scripts/perf-production-benchmark.mjs --runs 8 --scenario codex --ccusage-bin "$CCUSAGE_BIN"
node scripts/perf-production-benchmark.mjs --runs 8 --scenario claude --ccusage-bin "$CCUSAGE_BIN"

# or both scenarios in one run
node scripts/perf-production-benchmark.mjs --runs 8 --scenario all --ccusage-bin "$CCUSAGE_BIN"
```

The direct executable path keeps npm/npx resolution outside the measured command. The runner
isolates application config and cache state, fixes both tools to UTC, and rotates cell order. It
does not flush the OS filesystem page cache, so its states are fresh and warmed **application**
state rather than disk-cold and disk-warm. Stop the source tools or benchmark a stable snapshot so
session files do not change during the run. Replace the pinned ccusage version when intentionally
creating a new baseline.

Optional artifact outputs:

```bash
node scripts/perf-production-benchmark.mjs \
  --runs 8 \
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

Smoke-test the built CLI on Bun (needs `bun` on `PATH`):

```bash
pnpm run smoke:dist-bun
bun scripts/smoke-dist-opencode.mjs
```

Check npm package output:

```bash
pnpm run pack:check
```

## Test layout

- CLI unit tests: `tests/**`, by area (`tests/cli`, `tests/pricing`, `tests/render`, `tests/share-report`, …)
- Source parser tests and their fixtures: `packages/core/tests/sources/**` and `packages/core/tests/fixtures/**`
- End-to-end report tests: `tests/e2e/**`, over `tests/fixtures/e2e/<source>/`
- Goldens: `tests/golden/**` (below)
- Site script and docs contract tests: `tests/site/**`

## Goldens

`tests/golden` compares current output byte for byte with files committed under `tests/golden/__goldens__/`. They freeze:

- `events/`: the normalized events of each source's e2e fixtures, and of each set under `tests/fixtures/golden/<source>/<set>/` when that directory exists; all sources at once as JSONL, CSV and content hashes; OpenCode events before and after rows are appended to a stored database; a warm event-store run.
- `reports/`: every report command as JSON, markdown and plain terminal text (no colour, 120 columns), over all sources' e2e fixtures. Efficiency reads the Claude session with its `cwd` pointed at a temp git repo, so its goldens count commits and tokens.
- `help/`: `--help` for the root command and each top-level command, at 100 columns.
- `machines/`: the machine export bundle for the pi and codex fixtures, and usage by machine plus the summary after a synced machine's bundle is merged.
- `history/`: events and monthly usage with and without `--history`, over a store holding a departed file and a moved copy of a live file.
- `default-paths/`: `doctor --json` from a child process whose home, XDG and Windows profile variables each point at their own empty directory, so each source's default search paths are frozen. It runs on Linux only, since the defaults differ per platform.
- `variants/`: the statusline over all sources.

Each test file runs with a fixed clock (2026-06-21T12:00Z), `TZ=UTC`, bundled pricing only (no network), and an environment where source variables are unset and the config, data and cache dirs point into a temp root. In output, the temp root reads `<tmp>` and the fixture root `<fixtures>`. Nothing else is rewritten.

The report and events goldens read fixtures from a copy under the temp root with every mtime set to the fixed clock: most adapters skip files whose mtime predates `--since` minus a day, so checkout dates would otherwise change windowed reports. The dsh e2e fixture is dated 2026-09-11, after the fixed clock, on purpose: it appears in goldens that cover all dates but not in the summary, statusline or compare windows.

The harness writes out the 17 source ids and the top-level commands, and every golden name comes from a harness export. `orphans.golden.test.ts` fails when those lists drift from the source registry or the CLI, or when a file under `__goldens__/` is not one the tests write.

Run them:

```bash
TZ=UTC pnpm exec vitest run tests/golden
```

When a change is meant to move output, regenerate and rerun:

```bash
UPDATE_GOLDENS=1 TZ=UTC pnpm exec vitest run tests/golden
TZ=UTC pnpm exec vitest run tests/golden
```

The update run rewrites only files whose content differs and then fails, listing them, so it passes only when nothing moved. Review the diff and commit the regenerated files on their own, in a commit titled `goldens: <why>`.

Goldens are skipped on Windows, where paths and newline handling differ; CI's Linux and macOS jobs run them (verified locally on Linux under Node 22.16 and 24).

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
- test matrix: build, dist smoke and tests on Ubuntu, macOS and Windows with Node 22.16.0 and 24.21.0
- Mermaid validation (`docs/*.md`)
- Bun smoke (`pnpm run smoke:dist-bun`)
- core package: build, pack check, lint, typecheck, tests with its own coverage threshold, and the memory tests
- site: format check, `site:check`, generated docs up to date, `site:build`, `site:links`

Runtime:

- Node 24.21.0 (the matrix adds the minimum supported Node 22.16.0)
- pnpm 12.9.1

Coverage summary/artifacts are generated from the single Ubuntu Node 24 CI run.

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

The workflow uses Node `24.21.0` and its bundled npm 11 release. npm 11.5.1 or newer is required for trusted publishing; the pinned Node runtime already provides a compatible version.

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

1. Create `packages/core/src/sources/<name>/<name>-source-adapter.ts`, exported from
   `packages/core/src/sources/<name>/index.ts` and a `./sources/<name>` entry in
   `packages/core/package.json`
2. Implement `SourceAdapter`
   - required: `discoverFiles()` and `read(filePath, options)`, an `async function*` that yields the file's events in order and records each skipped row with `recordSkippedRow(options.diagnostics, reason)`; breaking out of the loop must close every handle the read opened (`packages/core/README.md` has the full contract)
   - optional: `getParseDependencies(filePath)` when parsing reads sidecar files (the event store fingerprints them)
   - optional: `parserVersion` (defaults to 1); bump it whenever the same unchanged file would parse into different events, so stored events are re-parsed
   - the event store caches a file's events by its fingerprint, so parsing must depend only on the file, its declared parse dependencies, and `parserVersion`; anything else that changes the result (a parent transcript, a decision based on the adapter's roots) must be returned from `getParseDependencies`
   - for JSONL sources, consider `readJsonlObjects(filePath, { shouldParseLine })` — or the faster byte-level `shouldParseLineBytes` — to skip irrelevant lines before `JSON.parse`
3. Normalize output through `createUsageEvent`
4. Add fixture tests under `packages/core/tests/sources/<name>`
5. Add one entry to `sourceRegistrations` in `packages/core/src/registry/adapters.ts`
   (id, storage format, `supportsSourceDir`, `parseInWorker`, and the constructor,
   which receives the `SourceContext`). Resolve default paths from that context when
   the adapter is constructed; never read `os.homedir()`, `process.env` or
   `process.platform` at module load (`packages/core/tests/no-import-side-effects.test.ts`
   checks this). Then add the CLI metadata in `src/cli/source-cli-options.ts`: an
   entry in `sourceCliOptions` (`{ key, flag, help }`) and the id in
   `dedicatedOptionOrderIds`, which sets the flag's position in `--help` and the CLI
   reference. Together they drive the dedicated `--<source>-dir`/`--<source>-db`
   flag and its help text, the `--source-dir` participation (directory-backed) or
   rejection (db-backed), the explicit-source detection in
   `resolveExplicitSourceIds`, blank-path validation, and the config
   `sourceDirs.<id>` → option-key mapping.
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
   - the sources table in `site/src/content/docs/sources/index.mdx` (a docs contract test requires a link to each registered source)
   - a `site/src/content/docs/sources/<id>.mdx` page (the sidebar entry is generated from `getDefaultSourceIds()`)
8. Extend the e2e expectations: fixtures under `tests/fixtures/e2e/<id>/` and the all-sources list plus totals in `tests/e2e/multi-source.e2e.test.ts`
9. Verify CLI filtering with `--source <name>`

Keep parsing logic isolated to the adapter. Do not spread source-specific assumptions across aggregation or rendering.
