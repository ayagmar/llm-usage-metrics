# Security Guide

This page documents the security controls and contributor steps configured in this repository.

## Current security-related controls

### Locked installs and reproducible tool versions

- CI, Pages, release, performance, and security workflows install dependencies with `pnpm install --frozen-lockfile` where dependencies are needed.
- The root package declares `"packageManager": "pnpm@11.13.0"` in `package.json`.
- GitHub Actions workflows use explicit runtime/tool versions:
  - Node.js `24.13.1`
  - pnpm `11.13.0`
  - npm bundled with Node.js `24.13.1` in the release workflow
- OpenCode support requires Node.js 24+ because it uses built-in `node:sqlite`.

### Dependency pinning and integrity

- Direct dependencies in `package.json` and `site/package.json` are pinned to exact versions.
- `pnpm-workspace.yaml` sets `saveExact: true` so future additions stay exact by default.
- `pnpm-workspace.yaml` allows dependency build scripts only for `esbuild` and `sharp`.
- The committed `pnpm-lock.yaml` is the real installation pin for this repo.
- `pnpm-lock.yaml` records `integrity: sha512-...` hashes for downloaded package tarballs.
- GitHub Actions workflows are pinned to full commit SHAs, with trailing version comments so automated updaters can keep them current.
- Repository settings require GitHub Actions to be pinned to full commit SHAs.
- The complete transitive dependency override policy lives in `pnpm-workspace.yaml`, keeping pnpm install policy in one place.

### Automated dependency upgrades

- `.github/dependabot.yml` enables weekly update PRs for:
  - root npm dependencies
  - `site/` npm dependencies
  - GitHub Actions workflow dependencies
- Dependabot labels those PRs with `dependencies` and `security`.

### Security scans in use

Dedicated security workflows are configured in `.github/workflows/security.yml`:

- **`pnpm audit --audit-level=moderate`** on pushes, pull requests, manual runs, and the weekly security schedule
- **Dependency Review** on pull requests, failing on moderate-or-higher findings in dependency changes
- **CodeQL** analysis for JavaScript/TypeScript on pushes, pull requests, and a weekly schedule

The regular CI workflow in `.github/workflows/ci.yml` enforces the normal quality gates:

- lint
- typecheck
- tests with coverage threshold enforcement
- build
- pack check
- site check/build

### Network and runtime behavior

- The CLI is local-first: it parses local session files and local Git history.
- Startup update checks only query the npm registry for the latest package version and are cached/skippable with `LLM_USAGE_SKIP_UPDATE_CHECK=1`.
- Pricing refreshes only fetch the LiteLLM pricing JSON; `--pricing-offline` runs from cache or the bundled LiteLLM snapshot.
- OpenCode parsing opens the SQLite database in read-only mode.
- The event store retains usage, session, and repository metadata. On POSIX systems, the default directory uses mode `0700`, and the database plus present WAL/SHM files use mode `0600`. Custom store parent-directory permissions remain the user's responsibility. Deleting the ledger deletes its retained history.

### Publishing and CI identity

- npm publishing is configured for **trusted publishing (OIDC)** in `.github/workflows/release.yml`.
- The release workflow does not require a long-lived npm publish token.
- Codecov uploads in CI use OIDC and pin the downloaded Codecov CLI version.
- The release workflow uses the npm version bundled with its pinned Node.js runtime; it does not install an ad-hoc global npm package.
- Workflows default to read-only repository contents and grant write access only to the jobs that need it, such as release publishing, Pages deployment, PR coverage comments, and CodeQL security-event uploads.
- Non-release checkouts disable credential persistence. The release checkout deliberately retains credentials because `release-it` pushes the release commit and tag.

## Contributor checklist

### For any change

Run the standard verification commands:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
```

### For dependency, workflow, or release-related changes

1. Verify the target version from authoritative sources first (official changelog/docs, npm registry, or the action's release page).
2. Make the smallest necessary change.
3. Run `pnpm install` so `pnpm-lock.yaml` stays in sync.
4. Review the lockfile diff and confirm only intended packages changed.
5. Keep `integrity: sha512-...` entries intact in the lockfile.
6. Preserve `pnpm install --frozen-lockfile` in workflows.
7. Keep GitHub Actions pinned to full commit SHAs and preserve repository-level SHA enforcement once it is enabled.
8. Keep the trailing action-version comments (for example `# v4.3.1`) so Dependabot can update pinned refs cleanly.
9. Keep build-script permissions limited to the explicit `allowBuilds` entries in `pnpm-workspace.yaml`.

Recommended validation for dependency or workflow changes:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm audit --audit-level=moderate
pnpm run build
pnpm run smoke:dist-opencode
pnpm run pack:check
pnpm run site:check
pnpm run site:build
```

## Dependency upgrade process

### Automated path

Prefer the existing Dependabot flow for routine upgrades.
Review its PRs carefully, especially lockfile and workflow changes.

### Manual path

For manual upgrades:

```bash
pnpm outdated
pnpm up --latest <package-name>
pnpm install
```

Then:

- review `package.json` and/or `site/package.json`
- review `pnpm-lock.yaml`
- review any workflow diff if GitHub Actions changed
- run the validation commands above
- mention noteworthy toolchain or security-related changes in the PR

## Release-specific guidance

- Use the GitHub Actions release workflow for real publishes.
- Keep OIDC trusted publishing in place; do not replace it with a long-lived npm token unless the repo is intentionally changing publishing strategy.
- If you modify `.github/workflows/release.yml`, keep the required Node/npm expectations aligned with `docs/development.md`.

## Reporting issues safely

When opening issues, redact secrets and sensitive local paths from logs before posting them.
The bug report template already asks contributors to redact secrets/paths where needed.
