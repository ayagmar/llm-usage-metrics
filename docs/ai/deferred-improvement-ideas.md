# Deferred Improvement Ideas

## Purpose

This index tracks improvement ideas that were evaluated as strong candidates
during the review pass but were intentionally **not** implemented in PR #119
(`feat/pricing-overrides-and-claude-dedup`). Each is documented concretely so
follow-on work can pick them up without re-deriving the analysis.

PR #119 shipped the two highest-confidence, smallest-scope fixes:

- `--pricing-overrides` (per-model pricing override decorator)
- Claude adapter dedup hardening (content-based fallback key)

The four ideas below are listed in descending order of strategic value.

## Index

| # | Idea | Status | Confidence | Why deferred |
| --- | --- | --- | --- | --- |
| 1 | [Local usage event store (SQLite)](./idea-event-store.md) | Not started | 80% | Multi-day architectural refactor; needs its own design effort |
| 7 | [Simplify interactive update install](./idea-update-install-simplification.md) | Not started | 70% | Removes a documented feature; requires maintainer product decision |
| 8 | [E2E multi-source fixture harness](./idea-e2e-fixture-harness.md) | Not started | 75% | Medium-large scope; `tests/e2e/` already has 4 e2e tests |
| 4 | [`llm-usage doctor` diagnostic command](./idea-doctor-command.md) | Not started | 85% | Small and high-value; deferred only to keep PR #119 focused |

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
3. **Update install simplification (#7)** — needs product sign-off first
4. **Local event store (#1)** — largest payoff, largest effort; do last
