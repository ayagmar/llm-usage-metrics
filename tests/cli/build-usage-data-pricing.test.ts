import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the LiteLLM fetcher so resolvePricingSource is exercised hermetically
// (no real cache file, no network). The mock primes a fixed pricing map and
// records whether load() read from cache.
const mockPricingByModel = new Map<string, { inputPer1MUsd: number; outputPer1MUsd: number }>();
let mockLoadedFromCache = false;
let mockLoadOrigin: 'cache' | 'network' | 'bundled-snapshot' | undefined;
let mockPricingWarning: string | undefined;

vi.mock('../../src/pricing/litellm-pricing-fetcher.js', () => {
  return {
    DEFAULT_LITELLM_PRICING_URL: 'https://example.test/litellm.json',
    LiteLLMPricingFetcher: class {
      public async load() {
        mockLoadOrigin = mockLoadOrigin ?? (mockLoadedFromCache ? 'cache' : 'network');
        return mockLoadedFromCache;
      }
      public getLoadOrigin() {
        return mockLoadOrigin;
      }
      public getPricingWarning() {
        return mockPricingWarning;
      }
      public resolveModelAlias(model: string) {
        return model.toLowerCase();
      }
      public getPricing(model: string) {
        return mockPricingByModel.get(model.toLowerCase());
      }
    },
  };
});

import {
  resolveAndApplyPricingToEvents,
  resolvePricingSource,
} from '../../src/cli/build-usage-data-pricing.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { DEFAULT_PRICING_POLICY } from '../../src/pricing/cost-engine.js';
import { StaticPricingSource } from '../helpers/static-pricing-source.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  mockPricingByModel.clear();
  mockLoadedFromCache = false;
  mockLoadOrigin = undefined;
  mockPricingWarning = undefined;
  vi.clearAllMocks();
});

function primePricing(models: Record<string, { inputPer1MUsd: number; outputPer1MUsd: number }>) {
  for (const [model, pricing] of Object.entries(models)) {
    mockPricingByModel.set(model.toLowerCase(), pricing);
  }
}

async function writeOverridesFile(dir: string, models: Record<string, unknown>): Promise<string> {
  const overridesPath = path.join(dir, 'pricing-overrides.json');
  await writeFile(overridesPath, JSON.stringify({ models }), 'utf8');
  return overridesPath;
}

describe('resolvePricingSource — pricing overrides wiring', () => {
  it('wraps the LiteLLM source with overrides when pricingOverrides is set', async () => {
    primePricing({
      'claude-opus-4-8': { inputPer1MUsd: 15, outputPer1MUsd: 75 },
      'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 },
    });
    mockLoadedFromCache = true;

    const dir = await mkdtemp(path.join(os.tmpdir(), 'resolve-pricing-overrides-'));
    tempDirs.push(dir);
    const overridesPath = await writeOverridesFile(dir, {
      'claude-opus-4-8': { inputPer1MUsd: 12, outputPer1MUsd: 60 },
    });

    const result = await resolvePricingSource(
      { pricingOffline: true, pricingOverrides: overridesPath },
      { cacheTtlMs: 60_000, fetchTimeoutMs: 1000 },
    );

    // Override wins for the overridden model.
    expect(result.source.getPricing('claude-opus-4-8')).toMatchObject({
      inputPer1MUsd: 12,
      outputPer1MUsd: 60,
    });
    // Non-overridden model falls through to the LiteLLM value.
    expect(result.source.getPricing('gpt-4.1')).toMatchObject({
      inputPer1MUsd: 2,
      outputPer1MUsd: 8,
    });
    expect(result.origin).toBe('offline-cache');
  });

  it('returns the LiteLLM source unchanged when no overrides path is given', async () => {
    primePricing({ 'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 } });
    mockLoadedFromCache = true;

    const result = await resolvePricingSource(
      { pricingOffline: true },
      { cacheTtlMs: 60_000, fetchTimeoutMs: 1000 },
    );

    expect(result.source.getPricing('gpt-4.1')).toMatchObject({
      inputPer1MUsd: 2,
      outputPer1MUsd: 8,
    });
    expect(result.origin).toBe('offline-cache');
  });

  it('returns bundled snapshot origin and warning when the fetcher uses the bundled snapshot', async () => {
    primePricing({ 'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 } });
    mockLoadedFromCache = true;
    mockLoadOrigin = 'bundled-snapshot';
    mockPricingWarning =
      'Pricing: using the bundled LiteLLM snapshot from 2026-07-08 (run online to refresh).';

    const result = await resolvePricingSource(
      { pricingOffline: true },
      { cacheTtlMs: 60_000, fetchTimeoutMs: 1000 },
    );

    expect(result.origin).toBe('bundled-snapshot');
    expect(result.warning).toBe(mockPricingWarning);
    expect(result.source.getPricing('gpt-4.1')).toMatchObject({
      inputPer1MUsd: 2,
      outputPer1MUsd: 8,
    });
  });

  it('reports a bad --pricing-overrides path as an overrides error, not a LiteLLM/cache failure', async () => {
    primePricing({ 'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 } });
    mockLoadedFromCache = true;

    const badPath = path.join(os.tmpdir(), `missing-overrides-${Date.now()}.json`);

    await expect(
      resolvePricingSource(
        { pricingOffline: true, pricingOverrides: badPath },
        { cacheTtlMs: 60_000, fetchTimeoutMs: 1000 },
      ),
    ).rejects.toThrow(/Could not load --pricing-overrides from/);
  });
});

describe('resolveAndApplyPricingToEvents — pricing run stats', () => {
  const loadStaticPricing = () =>
    Promise.resolve({
      source: new StaticPricingSource({
        pricingByModel: { 'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 } },
      }),
      origin: 'cache' as const,
    });
  const explicitZeroEvent = createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-16T10:00:00Z',
    model: 'gpt-4.1',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0,
    costMode: 'explicit',
  });

  it('returns the stats of the run that priced the events', async () => {
    const result = await resolveAndApplyPricingToEvents(
      [explicitZeroEvent],
      {},
      {
        loadPricingSource: loadStaticPricing,
      },
    );

    expect(result.pricingPolicy).toBe(DEFAULT_PRICING_POLICY);
    expect(result.pricedEvents[0]?.costMode).toBe('estimated');
    expect(result.pricingStats.reestimatedExplicitZero.has(result.pricedEvents[0])).toBe(true);
  });

  it('returns empty stats when pricing fails and failures are ignored', async () => {
    const result = await resolveAndApplyPricingToEvents(
      [explicitZeroEvent],
      { ignorePricingFailures: true },
      { loadPricingSource: () => Promise.reject(new Error('offline')) },
    );

    expect(result.pricedEvents).toEqual([explicitZeroEvent]);
    expect(result.pricingStats.reestimatedExplicitZero.has(explicitZeroEvent)).toBe(false);
  });
});
