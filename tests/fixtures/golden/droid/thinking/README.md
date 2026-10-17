# Droid session with thinking tokens

Imitates a Factory Droid session (`session-thinking.settings.json` plus its `.jsonl`) whose `tokenUsage` reports `thinkingTokens: 400`, `outputTokens: 100` and `inputTokens: 1000`.

Freezes KI-6. Nobody has checked whether Factory counts thinking inside `outputTokens` or next to it. Today the adapter reports `reasoningTokens` 400, `outputTokens` 100 and `totalTokens` 1100, so reasoning exceeds output and stays out of the total. Test: `tests/cli/sources/droid-thinking-fixture.test.ts`.
