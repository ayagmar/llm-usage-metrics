import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import modelMapPayload from '../../src/pricing/litellm-model-map.json' with { type: 'json' };
import {
  normalizeKey,
  resolveCanonicalModelKey,
} from '../../src/pricing/litellm-model-matching.js';
import {
  DEFAULT_LITELLM_PRICING_URL,
  LiteLLMPricingFetcher,
  normalizeLiteLLMCachePayload,
} from '../../src/pricing/litellm-pricing-fetcher.js';
import snapshotPayload from '../../src/pricing/litellm-pricing-snapshot.json' with { type: 'json' };
import retiredPricingPayload from '../../src/pricing/litellm-retired-pricing.json' with { type: 'json' };
import type { ModelPricing } from '../../src/pricing/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function toPricingMap(pricingByModel: Record<string, ModelPricing>): Map<string, ModelPricing> {
  return new Map(
    Object.entries(pricingByModel).map(([model, pricing]) => [normalizeKey(model), pricing]),
  );
}

const snapshotPricing = toPricingMap(
  snapshotPayload.pricingByModel as Record<string, ModelPricing>,
);

describe('LiteLLM pricing snapshot', () => {
  it('is a valid cache payload with usable model pricing', () => {
    const normalizedPayload = normalizeLiteLLMCachePayload(snapshotPayload);

    expect(normalizedPayload).toBeDefined();
    expect(normalizedPayload?.sourceUrl).toBe(DEFAULT_LITELLM_PRICING_URL);
    expect(normalizedPayload?.fetchedAt).toBeGreaterThan(Date.UTC(2024, 0, 1));
    expect(normalizedPayload?.fetchedAt).toBeLessThan(Date.now() + 24 * 60 * 60 * 1000);
    expect(Object.keys(normalizedPayload?.pricingByModel ?? {})).not.toHaveLength(0);
  });

  it('contains every preferred pricing key from the model map', () => {
    const missingKeys = Object.values(modelMapPayload.preferredPricingKeyByCanonicalModel).filter(
      (pricingKey) => !snapshotPricing.has(normalizeKey(pricingKey)),
    );

    expect(missingKeys).toEqual([]);
  });

  it('prices every model map alias', () => {
    const unpricedAliases = Object.keys(modelMapPayload.aliases).filter(
      (alias) => resolveCanonicalModelKey(normalizeKey(alias), snapshotPricing) === undefined,
    );

    expect(unpricedAliases).toEqual([]);
  });

  it('keeps retired models out of the current snapshot', () => {
    const retiredKeys = Object.keys(retiredPricingPayload.pricingByModel);

    expect(retiredKeys.length).toBeGreaterThan(0);
    expect(retiredKeys.filter((model) => snapshotPricing.has(normalizeKey(model)))).toEqual([]);
  });

  it('back-fills retired models into default-source pricing only', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-retired-pricing-'));
    tempDirs.push(rootDir);
    const createFetcher = (sourceUrl: string) =>
      new LiteLLMPricingFetcher({
        sourceUrl,
        cacheFilePath: path.join(rootDir, `${sourceUrl.length}.json`),
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                'gpt-4.1': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
              }),
              { status: 200 },
            ),
        ),
      });

    const defaultFetcher = createFetcher(DEFAULT_LITELLM_PRICING_URL);
    const customFetcher = createFetcher('https://example.test/litellm-pricing.json');
    await defaultFetcher.load();
    await customFetcher.load();

    expect(defaultFetcher.getPricing('claude-sonnet-4-20250514')).toBeDefined();
    expect(defaultFetcher.getPricing('gpt-4.1')?.inputPer1MUsd).toBeCloseTo(2, 10);
    expect(customFetcher.getPricing('claude-sonnet-4-20250514')).toBeUndefined();
  });
});
