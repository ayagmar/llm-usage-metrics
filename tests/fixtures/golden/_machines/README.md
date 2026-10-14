# Machine export bundles

`_machines` starts with an underscore so the golden fixture catalogue does not read it as a source id.

`older-parser-bundle.jsonl` imitates a `machine export` from another machine running an older codex parser. It holds the session from `tests/fixtures/e2e/codex/session.jsonl` under the path `/remote/codex/session.jsonl`. The timestamps match, but cache reads are folded into `inputTokens` and `cacheReadTokens` is 0.

Freezes KI-3. The bundle events hash differently from the local ones, so the merge keeps both copies: a report counts 4 events where 2 are expected. Test: `tests/machines/older-parser-bundle-fixture.test.ts`.
