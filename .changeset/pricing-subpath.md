---
'@ayagmar/agent-sessions': minor
---

Add the experimental `./pricing` entry point: `loadBundledPricing`, `fetchLiteLLMPricing`, `createPricingSource`, `withOverrides`, `priceEvents`, `estimateEventCostUsd` and `explainModelPricing` price usage events with LiteLLM rates the way `llm-usage` reports do. The bundled LiteLLM data ships under `dist/data/` and is read on first use. `fetchLiteLLMPricing` is the package's only network call, made with the global `fetch` when you call it.
