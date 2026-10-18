# Machine export bundles

`_machines` starts with an underscore so the golden fixture catalogue does not read it as a source id.

`older-parser-bundle.jsonl` imitates a `machine export` from another machine running an older codex parser. Its header records `"parserVersions":{"codex":"n2.p1"}`. It holds the session from `tests/fixtures/e2e/codex/session.jsonl` under the path `/remote/codex/session.jsonl`. The timestamps match, but cache reads are folded into `inputTokens` and `cacheReadTokens` is 0.

Covers KI-3. The bundle events hash differently from the local ones, so the merge matches them on timestamp instead: a report counts the 2 local events and warns about the parser versions. With `parserVersions` removed from the header (an export older than the field), the merge keeps both copies, 4 events, and notes that the machine should be synced after an update. Test: `tests/machines/older-parser-bundle-fixture.test.ts`.
