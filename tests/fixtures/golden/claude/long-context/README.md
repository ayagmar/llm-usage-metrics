# Claude request above 200k input tokens

Imitates one `claude-sonnet-4-5` request with a long context: `input_tokens` is 250000, cache fields and output are 0.

Freezes KI-1. Anthropic charges a higher rate above 200k input tokens, but the report prices the whole request at the base rate: $0.75 (250k at $3/M). Test: `tests/cli/sources/claude-long-context-fixture.test.ts`.
