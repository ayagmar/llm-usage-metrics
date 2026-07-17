# Production Release Checklist

Use this checklist for a release candidate. It intentionally stops before publishing: release approval and the version/tag decision remain human decisions.

## Before the release PR

- [ ] Confirm the working tree is clean and the release branch is based on `master`.
- [ ] Review user-visible changes in `CHANGELOG.md`, `README.md`, and `site/src/content/docs/`.
- [ ] Regenerate generated docs with `pnpm run site:docs:generate` and confirm there is no diff afterward.
- [ ] Confirm `pnpm-lock.yaml` matches every workspace manifest with `pnpm install --frozen-lockfile`.
- [ ] Review action references with `actionlint` and `uvx zizmor --pedantic .github/workflows`.
- [ ] Run `pnpm audit --audit-level=moderate` and resolve reachable high/critical findings.

## Verification gate

Run the same checks as CI from a clean install:

```bash
pnpm install --frozen-lockfile
pnpm run verify:ci
```

The gate covers lint, typecheck, tests and coverage thresholds, formatting, Mermaid validation, production build, distribution smoke test, package contents, generated docs, Astro checks, and site build.

## Release safety

- [ ] Review the package contents with `pnpm run pack:check`; do not ship local fixtures, coverage, or source-only files.
- [ ] Check the generated tarball includes the README and license and exposes only the `llm-usage` binary.
- [ ] Confirm the runtime requirement (Node.js 24+) and package manager pin are documented.
- [ ] Confirm no command in the release workflow publishes unless the release job is intentionally dispatched.
- [ ] Confirm pricing behavior is acceptable offline and that no session content is sent to the pricing service.
- [ ] Review share artifacts for sensitive data before attaching them to public posts.
- [ ] Get explicit approval for the version, tag, npm publication, and GitHub release.

## After approval

- [ ] Run the release command from the approved commit.
- [ ] Verify the npm tarball, GitHub release, and documentation deployment.
- [ ] Install the published version in a clean Node.js 24 environment and run `llm-usage doctor`.
- [ ] Record the version, commit SHA, verification result, and rollback notes in the release PR.
