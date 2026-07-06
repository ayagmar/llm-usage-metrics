import { describe, expect, it } from 'vitest';

import { buildWrappedData } from '../../src/cli/build-wrapped-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => eventsByFile[filePath] ?? [],
  };
}

function runtimeDeps(overrides: { adapters?: SourceAdapter[]; now?: () => Date } = {}) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 2,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({ enabled: false, path: '/tmp/events.db' }),
    getActiveEnvVarOverrides: () => [],
    createAdapters: () => overrides.adapters ?? [],
    resolvePricingSource: async (): Promise<PricingLoadResult> => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache',
    }),
    now: overrides.now,
  };
}

function createBaseEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-03-05T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    costMode: 'estimated',
    ...overrides,
  });
}

describe('buildWrappedData', () => {
  it('defaults to the current local year in the report timezone', async () => {
    const result = await buildWrappedData(
      {
        timezone: 'UTC',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ timestamp: '2026-01-01T00:00:00.000Z' }),
              createBaseEvent({ timestamp: '2025-12-31T23:59:00.000Z' }),
            ],
          }),
        ],
      }),
    );

    expect(result.recap.year).toBe(2026);
    expect(result.recap.totalTokens).toBe(1_000_000);
    expect(result.recap.totalCostUsd).toBe(2);
  });

  it('uses the requested year as the event range', async () => {
    const result = await buildWrappedData(
      {
        year: '2025',
        timezone: 'UTC',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ timestamp: '2026-01-01T00:00:00.000Z' }),
              createBaseEvent({ timestamp: '2025-12-31T23:59:00.000Z' }),
            ],
          }),
        ],
      }),
    );

    expect(result.recap.year).toBe(2025);
    expect(result.recap.totalTokens).toBe(1_000_000);
  });
});
