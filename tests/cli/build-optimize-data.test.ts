import { describe, expect, it, vi } from 'vitest';

import { buildOptimizeData } from '../../src/cli/build-optimize-data.js';
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

function runtimeDeps(
  overrides: {
    adapters?: SourceAdapter[];
    resolvePricingSource?: () => Promise<PricingLoadResult>;
  } = {},
) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 2,
      parseCacheEnabled: false,
      parseCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
      parseCacheMaxEntries: 2_000,
      parseCacheMaxBytes: 64 * 1024 * 1024,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getActiveEnvVarOverrides: () => [],
    createAdapters: () => overrides.adapters ?? [],
    resolvePricingSource:
      overrides.resolvePricingSource ??
      (async () => ({
        source: createDefaultOpenAiPricingSource(),
        origin: 'cache',
      })),
  };
}

function createBaseEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'estimated',
    ...overrides,
  });
}

describe('buildOptimizeData', () => {
  it('fails on multiple providers after filtering and before pricing load', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    await expect(
      buildOptimizeData(
        'daily',
        {
          candidateModel: ['gpt-4.1'],
        },
        runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/a.jsonl': [createBaseEvent({ provider: 'openai' })],
              '/tmp/b.jsonl': [createBaseEvent({ provider: 'anthropic' })],
            }),
          ],
          resolvePricingSource: pricingLoaderSpy,
        }),
      ),
    ).rejects.toThrow(
      'Optimize requires a single provider; found providers: anthropic, openai. Narrow with --provider.',
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
  });

  it('normalizes provider variants to a single billing provider scope', async () => {
    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-4.1'],
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent({ provider: 'openai' })],
            '/tmp/b.jsonl': [createBaseEvent({ provider: 'openai-codex' })],
          }),
        ],
      }),
    );

    expect(result.diagnostics.provider).toBe('openai');
  });

  it('rejects mixed canonical providers deterministically across adapters', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    await expect(
      buildOptimizeData(
        'daily',
        {
          candidateModel: ['gpt-4.1'],
        },
        runtimeDeps({
          adapters: [
            createAdapter('gemini', {
              '/tmp/gemini.json': [createBaseEvent({ source: 'gemini', provider: 'google' })],
            }),
            createAdapter('codex', {
              '/tmp/codex.jsonl': [createBaseEvent({ source: 'codex', provider: 'openai' })],
            }),
          ],
          resolvePricingSource: pricingLoaderSpy,
        }),
      ),
    ).rejects.toThrow(
      'Optimize requires a single provider; found providers: google, openai. Narrow with --provider.',
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
  });

  it('returns zero baseline and candidate costs for empty usage sets without pricing load', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-4.1'],
      },
      runtimeDeps({
        adapters: [createAdapter('pi', {})],
        resolvePricingSource: pricingLoaderSpy,
      }),
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();

    const baselineAll = result.rows.find(
      (row) => row.rowType === 'baseline' && row.periodKey === 'ALL',
    );
    const candidateAll = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(baselineAll).toMatchObject({ baselineCostUsd: 0, baselineCostIncomplete: false });
    expect(candidateAll).toMatchObject({
      hypotheticalCostUsd: 0,
      hypotheticalCostIncomplete: false,
      savingsUsd: 0,
    });
  });

  it('treats reasoning-only totals as non-zero billable tokens when pricing is unavailable', async () => {
    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-4.1'],
        ignorePricingFailures: true,
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/reasoning.jsonl': [
              createBaseEvent({
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 120,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
              }),
            ],
          }),
        ],
        resolvePricingSource: async () => {
          throw new Error('pricing unavailable');
        },
      }),
    );

    const candidateAll = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateAll).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['baseline_incomplete', 'missing_pricing'],
    });
  });

  it('treats total-only usage as cost-incomplete for optimize and skips pricing load', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-5.2'],
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/total-only.jsonl': [
              createBaseEvent({
                model: 'gpt-5.2',
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 75,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      }),
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.baselineCostIncomplete).toBe(true);

    const candidateAll = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateAll).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['baseline_incomplete', 'usage_buckets_missing'],
    });
  });

  it('omits savings and emits warning when baseline has cost but all token buckets are zero', async () => {
    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-4.1'],
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/tokenless.jsonl': [
              createBaseEvent({
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                costMode: 'explicit',
                costUsd: 3,
              }),
            ],
          }),
        ],
      }),
    );

    const candidateAll = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateAll).toMatchObject({
      savingsUsd: undefined,
      savingsPct: undefined,
      notes: ['baseline_tokens_missing', 'usage_buckets_missing'],
    });
    expect(result.diagnostics.warning).toContain('Baseline cost exists for zero-token periods');
  });

  it('falls back to normalized provider filter label when events have no provider', async () => {
    const result = await buildOptimizeData(
      'daily',
      {
        candidateModel: ['gpt-4.1'],
        provider: ' OpenAI ',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/no-provider.jsonl': [createBaseEvent({ provider: undefined })],
          }),
        ],
      }),
    );

    expect(result.diagnostics.provider).toBe('openai');
  });

  it('rejects ambiguous provider substring matches with actionable guidance', async () => {
    await expect(
      buildOptimizeData(
        'daily',
        {
          candidateModel: ['gpt-4.1'],
          provider: 'vendor',
        },
        runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/a.jsonl': [createBaseEvent({ provider: 'vendor-alpha' })],
              '/tmp/b.jsonl': [createBaseEvent({ provider: 'vendor-beta' })],
            }),
          ],
        }),
      ),
    ).rejects.toThrow(
      'Optimize matched multiple providers for --provider "vendor": vendor-alpha, vendor-beta. Supply a more specific --provider value.',
    );
  });

  it('rejects mixed providers when an exact provider match is still ambiguous by substring', async () => {
    await expect(
      buildOptimizeData(
        'daily',
        {
          candidateModel: ['gpt-4.1'],
          provider: 'openai',
        },
        runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/a.jsonl': [createBaseEvent({ provider: 'openai' })],
              '/tmp/b.jsonl': [createBaseEvent({ provider: 'vendor-openai' })],
            }),
          ],
        }),
      ),
    ).rejects.toThrow(
      'Optimize matched multiple providers for --provider "openai": openai, vendor-openai. Supply a more specific --provider value.',
    );
  });
});
