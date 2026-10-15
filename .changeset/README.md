# Changesets

Changesets version `@ayagmar/agent-sessions` (`packages/core`) only. The `llm-usage-metrics` CLI
at the repository root is not a workspace package and keeps releasing with release-it.

Add a changeset with `pnpm exec changeset` when a change to `packages/core` affects its public
subpaths, then run `pnpm run core:version` to apply the pending changesets. Nothing here
publishes: the package stays private.
