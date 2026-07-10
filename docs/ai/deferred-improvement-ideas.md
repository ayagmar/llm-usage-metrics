# Deferred Improvement Ideas

## Purpose

This index tracks improvement ideas that were evaluated as strong candidates
during the review pass but were intentionally **not** implemented in PR #119
(`feat/pricing-overrides-and-claude-dedup`). Each is documented concretely so
follow-on work can pick them up without re-deriving the analysis.

PR #119 shipped the two highest-confidence, smallest-scope fixes:

- `--pricing-overrides` (per-model pricing override decorator)
- Claude adapter dedup hardening (content-based fallback key)

The repo now ships 16 sources. The four ideas below are listed in descending order of strategic
value; ideas #4 and #8 are being implemented on `feat/improvements` (2026-07).

## Index

| #   | Idea                                                                            | Status                                       | Confidence | Why deferred                                                        |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| 1   | [Local usage event store (SQLite)](./idea-event-store.md)                       | Shipped v2 on `feat/improvements` (2026-07) | 80%        | Remaining work is pruning/compaction and compare-style reporting    |
| 7   | [Simplify interactive update install](./idea-update-install-simplification.md)  | Approved & implemented on `feat/improvements` (2026-07) | 70%        | Maintainer approved the product change on 2026-07-05                |
| 8   | [E2E multi-source fixture harness](./idea-e2e-fixture-harness.md)               | In progress on `feat/improvements` (2026-07) | 75%        | Medium-large scope; `tests/e2e/` already has 4 e2e tests            |
| 4   | [`llm-usage doctor` diagnostic command](./idea-doctor-command.md)               | In progress on `feat/improvements` (2026-07) | 85%        | Small and high-value; deferred only to keep PR #119 focused         |

## Carried-forward remediation items

Still-live items carried forward from the retired remediation plan for the
codebase's weakest parts (plan doc deleted; these are the surviving items):

- **Query planning / source pruning** — `--since/--until/--provider/--model`
  filter events after a full parse
  (`src/cli/build-usage-event-dataset.ts:103-131`); only codex/gemini declare
  `fixedProviderRoots`, so filters reduce output rather than parse work.
- **Model/provider identity consolidation** — three overlapping systems handle
  identity: `src/domain/provider-normalization.ts`, fuzzy matching in
  `src/pricing/litellm-pricing-fetcher.ts:241-330`, and
  `src/pricing/litellm-model-map.json`.
Completed from that plan (DONE, fixed in code): auxiliary-dependency
invalidation, global parse budget, gemini discovery scoping, and update-check
latency (the check now runs concurrently with the report and prints a stderr
hint afterwards; resolved with idea #7).

## Rejected ideas (not tracked here)

These were evaluated and rejected for concrete reasons; they are documented in
the PR #119 description for posterity and are **not** candidates:

- Period-over-period comparison — feature sprawl, not a weak-part fix
- Budget/threshold alerts — not a weakest-part fix; invents threshold semantics
- Session-level detail command — feature, not a weak-part fix
- Trends interactive HTML charts — goes against the terminal-first design

## Reading order

If tackling these, the recommended order is:

1. **`llm-usage doctor` (#4)** — smallest, isolated, immediate user value
2. **E2E fixture harness (#8)** — de-risks the other refactors
3. **Update install simplification (#7)** — DONE on `feat/improvements` (2026-07)
4. **Local event store (#1)** — DONE for v2; pruning/compaction and compare-style reporting remain parked
