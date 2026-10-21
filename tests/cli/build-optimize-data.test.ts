import { describe, expect, it, vi } from 'vitest';

import { buildOptimizeData } from '../../src/cli/build-optimize-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import {
  createDefaultOpenAiPricingSource,
  StaticPricingSource,
} from '../../packages/core/tests/helpers/static-pricing-source.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    read: readFrom(async (filePath) => eventsByFile[filePath] ?? []),
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
      parseWorkers: 0,
      parseWorkerMinBytes: 268_435_456,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({
      enabled: false as const,
      path: '/tmp/events.db',
      disabledBy: 'environment' as const,
    }),
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
  it('shows no savings for the model already in use when it writes one-hour cache', async () => {
    const sonnet = {
      inputPer1MUsd: 3,
      outputPer1MUsd: 15,
      cacheWritePer1MUsd: 3.75,
      cacheWrite1hPer1MUsd: 6,
    };
    const oneHourWrite = (day: string) =>
      createBaseEvent({
        source: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        timestamp: `${day}T10:00:00.000Z`,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
        totalTokens: 1_000_000,
      });

    const result = await buildOptimizeData(
      'daily',
      { candidateModel: ['claude-sonnet-4-5'], timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('claude', {
            '/tmp/a.jsonl': [oneHourWrite('2026-02-14'), oneHourWrite('2026-02-15')],
          }),
        ],
        resolvePricingSource: async () => ({
          source: new StaticPricingSource({ pricingByModel: { 'claude-sonnet-4-5': sonnet } }),
          origin: 'cache',
        }),
      }),
    );
    const candidateRows = result.rows.filter((row) => row.rowType === 'candidate');

    expect(candidateRows.map((row) => row.periodKey)).toEqual(['2026-02-14', '2026-02-15', 'ALL']);
    for (const row of candidateRows) {
      expect(row).toMatchObject({ savingsUsd: 0 });
    }
    expect(candidateRows.at(-1)).toMatchObject({ hypotheticalCostUsd: 12 });
  });

  // Candidates are priced at base rates, so the baseline must be too, even for a
  // per-request source whose request is above a long-context tier.
  it('shows no savings for the model already in use when a request is above a tier', async () => {
    const adapter: SourceAdapter = createAdapter('claude', {
      '/tmp/a.jsonl': [
        createBaseEvent({
          source: 'claude',
          provider: 'anthropic',
          model: 'claude-tiered',
          inputTokens: 150_000,
          outputTokens: 1_000,
          totalTokens: 151_000,
          singleRequest: true,
        }),
      ],
    });

    const result = await buildOptimizeData(
      'daily',
      { candidateModel: ['claude-tiered'], timezone: 'UTC' },
      runtimeDeps({
        adapters: [adapter],
        resolvePricingSource: async () => ({
          source: new StaticPricingSource({
            pricingByModel: {
              'claude-tiered': {
                inputPer1MUsd: 1,
                outputPer1MUsd: 5,
                tiers: [{ aboveTokens: 100_000, inputPer1MUsd: 5, outputPer1MUsd: 25 }],
              },
            },
          }),
          origin: 'cache',
        }),
      }),
    );
    const allCandidate = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(allCandidate).toMatchObject({ hypotheticalCostUsd: 0.155, savingsUsd: 0 });
  });

  it("scopes a multi-provider run to the candidates' provider as --provider would", async () => {
    // gpt-5 names a model exactly only in the copilot usage, so with --provider openai the
    // model rule falls back to a substring match and keeps gpt-5-codex.
    const adapters = [
      createAdapter('pi', {
        '/tmp/codex.jsonl': [
          createBaseEvent({ model: 'gpt-5-codex' }),
          createBaseEvent({ model: 'o3', inputTokens: 20, totalTokens: 25 }),
        ],
        '/tmp/copilot.jsonl': [
          createBaseEvent({ provider: 'github-copilot', model: 'gpt-5', totalTokens: 1_000 }),
        ],
      }),
    ];
    const options = { candidateModel: ['gpt-4.1'], model: ['gpt-5', 'o3'], timezone: 'UTC' };

    const inferred = await buildOptimizeData('daily', options, runtimeDeps({ adapters }));
    const explicit = await buildOptimizeData(
      'daily',
      { ...options, provider: 'openai' },
      runtimeDeps({ adapters }),
    );

    expect(inferred.diagnostics).toMatchObject({ provider: 'openai', inferredProvider: 'openai' });
    expect(explicit.diagnostics.inferredProvider).toBeUndefined();
    expect(inferred.rows).toEqual(explicit.rows);
    expect(
      inferred.rows.find((row) => row.rowType === 'baseline' && row.periodKey === 'ALL'),
    ).toMatchObject({ totalTokens: 40 });
  });

  it('fails on multiple providers before pricing load when the candidates span several', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    await expect(
      buildOptimizeData(
        'daily',
        { candidateModel: ['gpt-4.1', 'claude-sonnet-4-5'] },
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

  it('does not infer a provider that a source named with --source cannot have', async () => {
    const fixedTo = (adapter: SourceAdapter, root: string): SourceAdapter => ({
      ...adapter,
      capabilities: { fixedProviderRoots: [root] },
    });

    await expect(
      buildOptimizeData(
        'daily',
        { candidateModel: ['gpt-4.1'], source: ['codex', 'gemini'] },
        runtimeDeps({
          adapters: [
            fixedTo(
              createAdapter('codex', {
                '/tmp/codex.jsonl': [createBaseEvent({ source: 'codex' })],
              }),
              'openai',
            ),
            fixedTo(
              createAdapter('gemini', {
                '/tmp/gemini.json': [createBaseEvent({ source: 'gemini', provider: 'google' })],
              }),
              'google',
            ),
          ],
        }),
      ),
    ).rejects.toThrow(
      'Optimize requires a single provider; found providers: google, openai. Narrow with --provider.',
    );
  });

  it('does not infer a provider that would match several providers', async () => {
    await expect(
      buildOptimizeData(
        'daily',
        { candidateModel: ['gpt-4.1'] },
        runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/a.jsonl': [createBaseEvent({ provider: 'openai' })],
              '/tmp/b.jsonl': [createBaseEvent({ provider: 'azure-openai-responses' })],
            }),
          ],
        }),
      ),
    ).rejects.toThrow(
      'Optimize requires a single provider; found providers: azure-openai-responses, openai. Narrow with --provider.',
    );
  });

  it('does not infer a provider that is absent from the data', async () => {
    await expect(
      buildOptimizeData(
        'daily',
        { candidateModel: ['gpt-4.1'] },
        runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/a.jsonl': [createBaseEvent({ provider: 'anthropic' })],
              '/tmp/b.jsonl': [createBaseEvent({ provider: 'azure-openai-responses' })],
            }),
          ],
        }),
      ),
    ).rejects.toThrow(
      'Optimize requires a single provider; found providers: anthropic, azure-openai-responses. Narrow with --provider.',
    );
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
          // Its provider is not among the detected ones, so none is inferred.
          candidateModel: ['claude-sonnet-4-5'],
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
      savingsRatio: undefined,
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

describe('buildOptimizeData --last', () => {
  useIsolatedEnvironment();

  async function candidatePeriods(options: Parameters<typeof buildOptimizeData>[1]) {
    const result = await buildOptimizeData(
      'daily',
      { candidateModel: ['gpt-4.1'], timezone: 'UTC', ...options },
      {
        ...runtimeDeps({
          adapters: [
            createAdapter('pi', {
              '/tmp/pi.jsonl': ['2026-02-10', '2026-02-14', '2026-02-15'].map((day) =>
                createBaseEvent({ timestamp: `${day}T10:00:00.000Z` }),
              ),
            }),
          ],
        }),
        now: () => new Date('2026-02-15T12:00:00.000Z'),
      },
    );

    return result.rows.filter((row) => row.rowType === 'candidate').map((row) => row.periodKey);
  }

  it('covers the full history without it', async () => {
    expect(await candidatePeriods({})).toEqual(['2026-02-10', '2026-02-14', '2026-02-15', 'ALL']);
  });

  it('covers the last N periods of the granularity, counting the current one', async () => {
    expect(await candidatePeriods({ last: '2' })).toEqual(['2026-02-14', '2026-02-15', 'ALL']);
  });

  it("still scopes a multi-provider run to the candidates' provider", async () => {
    const adapters = [
      createAdapter('pi', {
        '/tmp/pi.jsonl': [
          createBaseEvent({ model: 'o3' }),
          createBaseEvent({
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            totalTokens: 1_000,
          }),
        ],
      }),
    ];
    const result = await buildOptimizeData(
      'daily',
      { candidateModel: ['gpt-4.1'], timezone: 'UTC', last: '7' },
      { ...runtimeDeps({ adapters }), now: () => new Date('2026-02-15T12:00:00.000Z') },
    );

    expect(result.diagnostics).toMatchObject({ inferredProvider: 'openai' });
    expect(
      result.rows.find((row) => row.rowType === 'baseline' && row.periodKey === 'ALL'),
    ).toMatchObject({ totalTokens: 15 });
  });

  it('rejects --last combined with --since', async () => {
    await expect(candidatePeriods({ last: '2', since: '2026-02-01' })).rejects.toThrow(
      '--last cannot be combined with --since, --until, or --all',
    );
  });
});
