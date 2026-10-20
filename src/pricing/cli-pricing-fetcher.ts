import path from 'node:path';

import {
  BundledPricingData,
  LiteLLMPricingFetcher,
  type LiteLLMPricingFetcherOptions,
} from '@ayagmar/agent-sessions/internal';

// The CLI bundles the pricing data into dist/index.js instead of reading the files the
// library ships: reading them saved under 5 ms of startup when measured, not worth shipping
// and locating data files next to the bundle.
import litellmPricingSnapshot from '../../packages/core/src/pricing/data/litellm-pricing-snapshot.json' with { type: 'json' };
import litellmRetiredPricing from '../../packages/core/src/pricing/data/litellm-retired-pricing.json' with { type: 'json' };
import litellmContextLimits from '../../packages/core/src/pricing/data/litellm-context-limits.json' with { type: 'json' };
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';

const inlinedPricingFiles = {
  snapshot: litellmPricingSnapshot,
  retiredPricing: litellmRetiredPricing,
  contextLimits: litellmContextLimits,
};

const cliBundledPricing = new BundledPricingData((file) =>
  Promise.resolve(inlinedPricingFiles[file]),
);

export function getDefaultLiteLLMPricingCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'litellm-pricing-cache.json');
}

/**
 * The CLI's fetcher: the user cache file, the global `fetch` and the inlined bundled data
 * unless the options say otherwise.
 */
export function createLiteLLMPricingFetcher(
  options: Partial<LiteLLMPricingFetcherOptions> = {},
): LiteLLMPricingFetcher {
  return new LiteLLMPricingFetcher({
    ...options,
    cacheFilePath: options.cacheFilePath ?? getDefaultLiteLLMPricingCachePath(),
    fetchImpl: options.fetchImpl ?? fetch,
    bundledPricing: options.bundledPricing ?? cliBundledPricing,
  });
}
