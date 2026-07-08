import { describe, expect, it } from 'vitest';

import snapshotPayload from '../../src/pricing/litellm-pricing-snapshot.json' with { type: 'json' };
import {
  DEFAULT_LITELLM_PRICING_URL,
  normalizeLiteLLMCachePayload,
} from '../../src/pricing/litellm-pricing-fetcher.js';

describe('LiteLLM pricing snapshot', () => {
  it('is a valid cache payload with usable model pricing', () => {
    const normalizedPayload = normalizeLiteLLMCachePayload(snapshotPayload);

    expect(normalizedPayload).toBeDefined();
    expect(normalizedPayload?.sourceUrl).toBe(DEFAULT_LITELLM_PRICING_URL);
    expect(normalizedPayload?.fetchedAt).toBeGreaterThan(Date.UTC(2024, 0, 1));
    expect(normalizedPayload?.fetchedAt).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
    expect(Object.keys(normalizedPayload?.pricingByModel ?? {})).not.toHaveLength(0);
  });
});
