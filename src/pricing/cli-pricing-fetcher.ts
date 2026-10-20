import path from 'node:path';

import {
  LiteLLMPricingFetcher,
  type LiteLLMPricingFetcherOptions,
} from '@ayagmar/agent-sessions/pricing';

import { getUserCacheRootDir } from '../utils/cache-root-dir.js';

export function getDefaultLiteLLMPricingCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'litellm-pricing-cache.json');
}

/** The CLI's fetcher: the user cache file and the global `fetch` unless the options say otherwise. */
export function createLiteLLMPricingFetcher(
  options: Partial<LiteLLMPricingFetcherOptions> = {},
): LiteLLMPricingFetcher {
  return new LiteLLMPricingFetcher({
    ...options,
    cacheFilePath: options.cacheFilePath ?? getDefaultLiteLLMPricingCachePath(),
    fetchImpl: options.fetchImpl ?? fetch,
  });
}
