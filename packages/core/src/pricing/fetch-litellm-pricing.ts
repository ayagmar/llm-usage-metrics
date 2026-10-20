import { setTimeout as sleep } from 'node:timers/promises';

import {
  createLiteLLMPricingTable,
  DEFAULT_FETCH_RETRY_COUNT,
  DEFAULT_FETCH_RETRY_DELAY_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_LITELLM_PRICING_URL,
  MAX_LITELLM_PRICING_RESPONSE_BYTES,
  normalizeLitellmContextLimits,
  normalizeLitellmPricingPayload,
  packagedPricingData,
  requestLiteLLMPricingPayload,
} from './litellm-pricing-fetcher.js';
import type { PricingSource } from './types.js';

/** Options for {@link fetchLiteLLMPricing}. */
export type FetchLiteLLMPricingOptions = {
  /** The pricing JSON to fetch; LiteLLM's `model_prices_and_context_window.json` by default. */
  url?: string;
  /** Aborts the fetch, including its retries. */
  signal?: AbortSignal;
  /** The largest response accepted, in bytes; 32 MiB by default. */
  maxBytes?: number;
};

/**
 * Fetches current prices from LiteLLM: the one function in this package that calls the
 * network. It makes a GET request with the global `fetch`, retries a timeout (4 s per
 * attempt), a network error or a 408/425/429/5xx status twice, and rejects when every
 * attempt fails; it writes no file and does not fall back on the bundled prices. From the
 * default URL, the bundled retired prices and context limits fill in what LiteLLM no longer
 * lists.
 */
export async function fetchLiteLLMPricing(
  options: FetchLiteLLMPricingOptions = {},
): Promise<PricingSource> {
  const url = options.url ?? DEFAULT_LITELLM_PRICING_URL;
  const { signal } = options;
  const payload = await requestLiteLLMPricingPayload({
    url,
    // This file is the core's only network call, allowed by the lint config: the caller
    // asked for it by calling fetchLiteLLMPricing.
    fetchImpl: fetch,
    timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    retryCount: DEFAULT_FETCH_RETRY_COUNT,
    retryDelayMs: DEFAULT_FETCH_RETRY_DELAY_MS,
    maxResponseBytes: options.maxBytes ?? MAX_LITELLM_PRICING_RESPONSE_BYTES,
    sleep: (delayMs) => sleep(delayMs, undefined, signal ? { signal } : {}),
    ...(signal ? { signal } : {}),
  });
  const pricingByModel = normalizeLitellmPricingPayload(payload);

  return createLiteLLMPricingTable(pricingByModel, {
    maxInputTokensByModel: Object.fromEntries(
      normalizeLitellmContextLimits(payload, pricingByModel),
    ),
    origin: { kind: 'network', fetchedAt: Date.now(), url },
    bundledPricing: url === DEFAULT_LITELLM_PRICING_URL ? packagedPricingData : undefined,
  });
}
