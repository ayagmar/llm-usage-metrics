### `claude-sonnet-4-5-20250929`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | claude-sonnet-4-5-20250929                                                                                                                    |
| Pricing key    | claude-sonnet-4-5-20250929                                                                                                                    |
| Rule           | direct                                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $3.00 / 1M                                                                                                                                    |
| Output         | $15.00 / 1M                                                                                                                                   |
| Cache read     | $0.30 / 1M                                                                                                                                    |
| Cache write    | $3.75 / 1M                                                                                                                                    |
| Cache write 1h | $6.00 / 1M                                                                                                                                    |
| Reasoning      | billed as output                                                                                                                              |

### `k2p5`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | k2p5                                                                                                                                          |
| Pricing key    | moonshot/kimi-k2.5                                                                                                                            |
| Rule           | model map to kimi-k2.5, then the model map's preferred key                                                                                    |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $0.60 / 1M                                                                                                                                    |
| Output         | $3.00 / 1M                                                                                                                                    |
| Cache read     | $0.10 / 1M                                                                                                                                    |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |

### `gpt-5.4-high`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | gpt-5.4-high                                                                                                                                  |
| Pricing key    | gpt-5.4                                                                                                                                       |
| Rule           | effort suffix dropped \(as gpt-5.4\)                                                                                                          |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $2.50 / 1M                                                                                                                                    |
| Output         | $15.00 / 1M                                                                                                                                   |
| Cache read     | $0.25 / 1M                                                                                                                                    |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |
| Above 272,000  | input $5.00 / 1M, output $22.50 / 1M, cache read $0.50 / 1M                                                                                   |

### `deepseek-v3.2`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | deepseek-v3.2                                                                                                                                 |
| Pricing key    | deepseek/deepseek-v3.2                                                                                                                        |
| Rule           | provider-prefixed key                                                                                                                         |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $0.28 / 1M                                                                                                                                    |
| Output         | $0.40 / 1M                                                                                                                                    |
| Cache read     | $0.028 / 1M                                                                                                                                   |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |

### `gpt52codex`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | gpt52codex                                                                                                                                    |
| Pricing key    | gpt-5.2-codex                                                                                                                                 |
| Rule           | fuzzy, edit distance 0                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $1.75 / 1M                                                                                                                                    |
| Output         | $14.00 / 1M                                                                                                                                   |
| Cache read     | $0.175 / 1M                                                                                                                                   |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |

### `claude-3-7-sonnet-20250219`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | claude-3-7-sonnet-20250219                                                                                                                    |
| Pricing key    | claude-3-7-sonnet-20250219                                                                                                                    |
| Rule           | direct                                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Retired        | yes, priced from retired LiteLLM prices                                                                                                       |
| Input          | $3.00 / 1M                                                                                                                                    |
| Output         | $15.00 / 1M                                                                                                                                   |
| Cache read     | $0.30 / 1M                                                                                                                                    |
| Cache write    | $3.75 / 1M                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |

### `gemini-2.5-pro`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | gemini-2.5-pro                                                                                                                                |
| Pricing key    | gemini-2.5-pro                                                                                                                                |
| Rule           | direct                                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $1.25 / 1M                                                                                                                                    |
| Output         | $10.00 / 1M                                                                                                                                   |
| Cache read     | $0.125 / 1M                                                                                                                                   |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |
| Above 200,000  | input $2.50 / 1M, output $15.00 / 1M, cache read $0.25 / 1M, cache write $0.25 / 1M                                                           |

### `fireworks_ai/accounts/fireworks/models/minimax-m2p7`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | fireworks\_ai/accounts/fireworks/models/minimax-m2p7                                                                                          |
| Pricing key    | fireworks\_ai/accounts/fireworks/models/minimax-m2p7                                                                                          |
| Rule           | direct                                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $1.20 / 1M                                                                                                                                    |
| Output         | $1.20 / 1M                                                                                                                                    |
| Cache read     | $0.60 / 1M                                                                                                                                    |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |
| Priority rates | stand in for input, output, cacheRead                                                                                                         |

### `gpt-5-codex-mini`

| Field       | Value                                                                                                                                         |
| :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized  | gpt-5-codex-mini                                                                                                                              |
| Pricing key | unpriced                                                                                                                                      |
| Rule        | no pricing key matched                                                                                                                        |
| Override    | none                                                                                                                                          |
| Searched    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |

### `acme-internal-model`

| Field          | Value                      |
| :------------- | :------------------------- |
| Normalized     | acme-internal-model        |
| Pricing key    | acme-internal-model        |
| Rule           | override keyed on the name |
| Override       | yes, keyed on the name     |
| Prices from    | pricing overrides file     |
| Input          | $1.00 / 1M                 |
| Output         | $2.00 / 1M                 |
| Cache read     | $0.10 / 1M                 |
| Cache write    | not listed                 |
| Cache write 1h | as cache write             |
| Reasoning      | billed as output           |

### `claude-opus-4-8-thinking`

| Field          | Value                         |
| :------------- | :---------------------------- |
| Normalized     | claude-opus-4-8-thinking      |
| Pricing key    | claude-opus-4-8               |
| Rule           | key plus a release suffix     |
| Override       | yes, keyed on the pricing key |
| Prices from    | pricing overrides file        |
| Input          | $12.00 / 1M                   |
| Output         | $60.00 / 1M                   |
| Cache read     | not listed                    |
| Cache write    | not listed                    |
| Cache write 1h | as cache write                |
| Reasoning      | $70.00 / 1M                   |

### `"  GPT-5.5  "`

| Field          | Value                                                                                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized     | gpt-5.5                                                                                                                                       |
| Pricing key    | gpt-5.5                                                                                                                                       |
| Rule           | direct                                                                                                                                        |
| Override       | none                                                                                                                                          |
| Prices from    | bundled LiteLLM snapshot from 2026-10-15 \(https\://raw.githubusercontent.com/BerriAI/litellm/main/model\_prices\_and\_context\_window.json\) |
| Input          | $5.00 / 1M                                                                                                                                    |
| Output         | $30.00 / 1M                                                                                                                                   |
| Cache read     | $0.50 / 1M                                                                                                                                    |
| Cache write    | not listed                                                                                                                                    |
| Cache write 1h | as cache write                                                                                                                                |
| Reasoning      | billed as output                                                                                                                              |
| Above 272,000  | input $10.00 / 1M, output $45.00 / 1M, cache read $1.00 / 1M                                                                                  |

"Above N" rates apply per request when its prompt (input, cache read and cache write tokens) is above N, and only to events from: antigravity, claude, gemini, opencode, pi.