# Claude request with a prompt above 100k tokens

Imitates one `claude-haiku-5-5` request with a long prompt: 50,000 input tokens, 90,000 cache reads and 10,000 cache writes (five-minute), so the prompt is 150,000 tokens, plus 1,000 output tokens.

Anthropic prices Claude Haiku 5.5 by prompt length: a request whose prompt is over 100,000 tokens, counting cache reads and cache writes, pays higher rates. LiteLLM lists them as `*_above_100k_tokens`: $0.50/M input, $0.05/M cache read, $0.625/M cache write and $2.50/M output. The request costs $0.03825 at those rates ($0.00765 at the base rates). This was KI-1. Test: `tests/cli/sources/claude-long-context-fixture.test.ts`.
