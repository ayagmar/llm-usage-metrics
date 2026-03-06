import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { buildUsageDiagnostics } from '../../src/cli/build-usage-data-diagnostics.js';
import {
  normalizeSourceFilter,
  selectAdaptersForParsing,
} from '../../src/cli/build-usage-data-inputs.js';
import {
  filterParsedAdapterEvents,
  filterUsageEvents,
} from '../../src/cli/build-usage-data-parsing.js';
import { shouldLoadPricingSource } from '../../src/cli/build-usage-data-pricing.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';

const tempDirs: string[] = [];
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;

  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }

  vi.unstubAllGlobals();
});

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
  capabilities?: SourceAdapter['capabilities'],
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    capabilities,
    discoverFiles: async () => files,
    parseFile: async (filePath) => eventsByFile[filePath] ?? [],
  };
}

function createFailingAdapter(
  id: SourceAdapter['id'],
  errorMessage: string,
  failurePoint: 'discover' | 'parse' = 'parse',
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => {
      if (failurePoint === 'discover') {
        throw new Error(errorMessage);
      }

      return ['/tmp/failing-source.jsonl'];
    },
    parseFile: async () => {
      throw new Error(errorMessage);
    },
  };
}

function createAdapterWithDiagnostics(
  id: SourceAdapter['id'],
  parseDiagnosticsByFile: Partial<
    Record<
      string,
      {
        events: ReturnType<typeof createUsageEvent>[];
        skippedRows: number;
        skippedRowReasons?: Array<{ reason: string; count: number }>;
      }
    >
  >,
): SourceAdapter {
  const files = Object.keys(parseDiagnosticsByFile);

  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => parseDiagnosticsByFile[filePath]?.events ?? [],
    parseFileWithDiagnostics: async (filePath) =>
      parseDiagnosticsByFile[filePath] ?? { events: [], skippedRows: 0 },
  };
}

function createEvent(
  overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {},
): ReturnType<typeof createUsageEvent> {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 0.03,
    ...overrides,
  });
}

function withDeterministicRuntimeDeps() {
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
  };
}

describe('build-usage-data helper modules', () => {
  it('normalizes source filters and preserves adapter order during selection', () => {
    const sourceFilter = normalizeSourceFilter([' codex, pi ', 'codex']);

    const selectedAdapters = selectAdaptersForParsing(
      [createAdapter('pi', {}), createAdapter('codex', {}), createAdapter('opencode', {})],
      {
        sourceFilter,
        candidateProviderRoots: undefined,
      },
    );

    expect(sourceFilter ? [...sourceFilter] : []).toEqual(['codex', 'pi']);
    expect(selectedAdapters.map((adapter) => adapter.id)).toEqual(['pi', 'codex']);
  });

  it('prunes fixed-provider sources during selection when provider roots make them impossible', () => {
    const selectedAdapters = selectAdaptersForParsing(
      [
        createAdapter('pi', {}),
        createAdapter('codex', {}, { fixedProviderRoots: ['openai'] }),
        createAdapter('gemini', {}, { fixedProviderRoots: ['google'] }),
      ],
      {
        sourceFilter: undefined,
        candidateProviderRoots: ['openai'],
      },
    );

    expect(selectedAdapters.map((adapter) => adapter.id)).toEqual(['pi', 'codex']);
  });

  it('uses post-date-filter model availability when choosing exact vs substring matching', () => {
    const filteredEvents = filterUsageEvents(
      [
        createEvent({
          timestamp: '2026-02-13T10:00:00.000Z',
          model: 'claude-sonnet-4.5',
          totalTokens: 10,
        }),
        createEvent({
          timestamp: '2026-02-14T10:00:00.000Z',
          model: 'claude-sonnet-4.5-v2',
          totalTokens: 20,
        }),
      ],
      {
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        modelFilter: ['claude-sonnet-4.5'],
      },
    );

    expect(filteredEvents).toHaveLength(1);
    expect(filteredEvents[0]?.model).toBe('claude-sonnet-4.5-v2');
  });

  it('applies provider/date/model filtering directly from parsed adapter results', () => {
    const filteredEvents = filterParsedAdapterEvents(
      [
        {
          source: 'pi',
          events: [
            createEvent({
              source: 'pi',
              timestamp: '2026-02-13T10:00:00.000Z',
              provider: 'openai',
              model: 'gpt-4.1',
              sessionId: 'session-pi-1',
            }),
          ],
          filesFound: 1,
          skippedRows: 0,
          skippedRowReasons: [],
        },
        {
          source: 'codex',
          events: [
            createEvent({
              source: 'codex',
              timestamp: '2026-02-14T10:00:00.000Z',
              provider: 'openai',
              model: 'gpt-4.1-mini',
              sessionId: 'session-codex-1',
            }),
            createEvent({
              source: 'codex',
              timestamp: '2026-02-14T10:00:10.000Z',
              provider: 'anthropic',
              model: 'claude-sonnet-4.5',
              sessionId: 'session-codex-2',
            }),
          ],
          filesFound: 1,
          skippedRows: 0,
          skippedRowReasons: [],
        },
      ],
      {
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        providerFilter: 'openai',
        modelFilter: ['gpt-4.1'],
      },
    );

    expect(filteredEvents).toHaveLength(1);
    expect(filteredEvents[0]).toMatchObject({
      source: 'codex',
      sessionId: 'session-codex-1',
      model: 'gpt-4.1-mini',
    });
  });

  it('decides pricing loading based on model presence, usage, and explicit cost state', () => {
    expect(shouldLoadPricingSource([])).toBe(false);
    expect(
      shouldLoadPricingSource([
        createEvent({
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMode: 'estimated',
          costUsd: undefined,
        }),
      ]),
    ).toBe(false);
    expect(
      shouldLoadPricingSource([
        createEvent({
          model: undefined,
          costMode: 'estimated',
          costUsd: undefined,
        }),
      ]),
    ).toBe(false);
    expect(
      shouldLoadPricingSource([
        createEvent({
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 42,
          costMode: 'estimated',
          costUsd: undefined,
        }),
      ]),
    ).toBe(false);
    expect(
      shouldLoadPricingSource([
        createEvent({
          costMode: 'explicit',
          costUsd: 0.12,
        }),
      ]),
    ).toBe(false);
    expect(
      shouldLoadPricingSource([
        createEvent({
          costMode: 'estimated',
          costUsd: undefined,
        }),
      ]),
    ).toBe(true);
    expect(
      shouldLoadPricingSource([
        createEvent({
          costMode: 'explicit',
          costUsd: 0,
        }),
      ]),
    ).toBe(true);
  });

  it('assembles diagnostics from parse results while preserving adapter order', () => {
    const diagnostics = buildUsageDiagnostics({
      adaptersToParse: [createAdapter('pi', {}), createAdapter('codex', {})],
      successfulParseResults: [
        {
          source: 'codex',
          events: [
            createEvent({ source: 'codex', sessionId: 'codex-session-1' }),
            createEvent({ source: 'codex', sessionId: 'codex-session-2' }),
          ],
          filesFound: 2,
          skippedRows: 3,
          skippedRowReasons: [{ reason: 'invalid_data_json', count: 3 }],
        },
      ],
      sourceFailures: [{ source: 'pi', reason: 'pi parse failed' }],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
    });

    expect(diagnostics).toMatchObject({
      sessionStats: [
        { source: 'pi', filesFound: 0, eventsParsed: 0 },
        { source: 'codex', filesFound: 2, eventsParsed: 2 },
      ],
      sourceFailures: [{ source: 'pi', reason: 'pi parse failed' }],
      skippedRows: [
        {
          source: 'codex',
          skippedRows: 3,
          reasons: [{ reason: 'invalid_data_json', count: 3 }],
        },
      ],
      pricingOrigin: 'none',
      timezone: 'UTC',
    });
  });
});

describe('buildUsageData', () => {
  it('returns no-sessions diagnostics without loading pricing', async () => {
    const pricingLoaderSpy = vi.fn(async (): Promise<PricingLoadResult> => {
      throw new Error('pricing should not be loaded when there are no events');
    });

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [createAdapter('pi', {}), createAdapter('codex', {})],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics).toMatchObject({
      sessionStats: [
        { source: 'pi', filesFound: 0, eventsParsed: 0 },
        { source: 'codex', filesFound: 0, eventsParsed: 0 },
      ],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      timezone: 'UTC',
    });
    expect(result.rows).toEqual([
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    ]);
  });

  it.each([
    ['--pricing-offline', { pricingOffline: true }],
    ['--pricing-url', { pricingUrl: 'https://example.test/pricing.json' }],
  ] as const)(
    'does not load pricing when %s is set but there are no events',
    async (_, options) => {
      const pricingLoaderSpy = vi.fn(async (): Promise<PricingLoadResult> => {
        throw new Error('pricing should not be loaded when there are no events');
      });

      const result = await buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          ...options,
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [createAdapter('pi', {}), createAdapter('codex', {})],
          resolvePricingSource: pricingLoaderSpy,
        },
      );

      expect(pricingLoaderSpy).not.toHaveBeenCalled();
      expect(result.diagnostics.pricingOrigin).toBe('none');
      expect(result.rows).toEqual([
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: [],
          modelBreakdown: [],
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      ]);
    },
  );

  it('does not load pricing when parsed events have zero total tokens only', async () => {
    const pricingLoaderSpy = vi.fn(async (): Promise<PricingLoadResult> => {
      throw new Error('pricing should not be loaded when all events are zero-usage');
    });

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                costMode: 'estimated',
                costUsd: undefined,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.pricingOrigin).toBe('none');
  });

  it('leaves total-only usage cost-incomplete instead of estimating $0', async () => {
    const pricingLoaderSpy = vi.fn(async (): Promise<PricingLoadResult> => {
      throw new Error('pricing should not be loaded for total-only usage');
    });

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-total-only.jsonl': [
              createEvent({
                model: 'gpt-5.2',
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 42,
                costMode: 'estimated',
                costUsd: undefined,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.pricingOrigin).toBe('none');
    expect(result.events[0]).toMatchObject({
      totalTokens: 42,
      costUsd: undefined,
      costMode: 'estimated',
    });
    expect(result.rows).toEqual([
      {
        rowType: 'period_source',
        periodKey: '2026-02-14',
        source: 'pi',
        models: ['gpt-5.2'],
        modelBreakdown: [
          {
            model: 'gpt-5.2',
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 42,
            costIncomplete: true,
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 42,
        costIncomplete: true,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-5.2'],
        modelBreakdown: [
          {
            model: 'gpt-5.2',
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 42,
            costIncomplete: true,
          },
        ],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 42,
        costIncomplete: true,
      },
    ]);
  });

  it('supports source filtering and preserves adapter order in session diagnostics', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        source: 'codex',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [createEvent({ source: 'pi', sessionId: 'pi-session' })],
          }),
          createAdapter('codex', {
            '/tmp/codex-1.jsonl': [
              createEvent({ source: 'codex', sessionId: 'codex-session', model: undefined }),
            ],
          }),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      {
        source: 'codex',
        filesFound: 1,
        eventsParsed: 1,
      },
    ]);

    const sourceRows = result.rows.filter((row) => row.rowType === 'period_source');
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].source).toBe('codex');
    expect(result.rows.some((row) => row.rowType === 'period_combined')).toBe(false);
  });

  it('prunes fixed-provider gemini before discovery when --provider openai is supplied', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        provider: 'openai',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          {
            id: 'gemini',
            capabilities: { fixedProviderRoots: ['google'] },
            discoverFiles: async () => {
              throw new Error('gemini should have been pruned');
            },
            parseFile: async () => [],
          },
          createAdapter(
            'codex',
            {
              '/tmp/codex-openai.jsonl': [
                createEvent({ source: 'codex', provider: 'openai', sessionId: 'codex-openai' }),
              ],
            },
            { fixedProviderRoots: ['openai'] },
          ),
        ],
      },
    );

    expect(result.diagnostics.sourceFailures).toEqual([]);
    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'codex', filesFound: 1, eventsParsed: 1 },
    ]);
  });

  it('prunes fixed-provider gemini before discovery when explicit model filters infer openai', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        model: 'gpt-5.2',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          {
            id: 'gemini',
            capabilities: { fixedProviderRoots: ['google'] },
            discoverFiles: async () => {
              throw new Error('gemini should have been pruned');
            },
            parseFile: async () => [],
          },
          createAdapter(
            'codex',
            {
              '/tmp/codex-gpt52.jsonl': [
                createEvent({
                  source: 'codex',
                  provider: 'openai',
                  model: 'gpt-5.2',
                  sessionId: 'codex-gpt52',
                }),
              ],
            },
            { fixedProviderRoots: ['openai'] },
          ),
        ],
      },
    );

    expect(result.diagnostics.sourceFailures).toEqual([]);
    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'codex', filesFound: 1, eventsParsed: 1 },
    ]);
  });

  it('records non-explicit source failures in diagnostics and continues with healthy sources', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [createEvent({ source: 'pi', sessionId: 'pi-session' })],
          }),
          createFailingAdapter('codex', 'codex parse failed'),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'pi', filesFound: 1, eventsParsed: 1 },
      { source: 'codex', filesFound: 0, eventsParsed: 0 },
    ]);
    expect(result.diagnostics.sourceFailures).toEqual([
      { source: 'codex', reason: 'codex parse failed' },
    ]);
    expect(result.diagnostics.skippedRows).toEqual([]);

    const sourceRows = result.rows.filter((row) => row.rowType === 'period_source');
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].source).toBe('pi');
  });

  it('propagates adapter skipped-row diagnostics into usage diagnostics', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapterWithDiagnostics('opencode', {
            '/tmp/opencode.db': {
              events: [createEvent({ source: 'opencode', sessionId: 'opencode-session' })],
              skippedRows: 2,
              skippedRowReasons: [
                { reason: 'invalid_data_json', count: 1 },
                { reason: 'missing_timestamp', count: 1 },
              ],
            },
          }),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'opencode', filesFound: 1, eventsParsed: 1 },
    ]);
    expect(result.diagnostics.skippedRows).toEqual([
      {
        source: 'opencode',
        skippedRows: 2,
        reasons: [
          { reason: 'invalid_data_json', count: 1 },
          { reason: 'missing_timestamp', count: 1 },
        ],
      },
    ]);
  });

  it('normalizes invalid skipped-row diagnostics emitted by adapters', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapterWithDiagnostics('opencode', {
            '/tmp/opencode-a.db': {
              events: [createEvent({ source: 'opencode', sessionId: 'opencode-session-a' })],
              skippedRows: Number.NaN,
            },
            '/tmp/opencode-b.db': {
              events: [createEvent({ source: 'opencode', sessionId: 'opencode-session-b' })],
              skippedRows: -3,
            },
          }),
        ],
      },
    );

    expect(result.diagnostics.skippedRows).toEqual([]);
  });

  it('fails when an explicitly selected source cannot be parsed', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          source: 'codex',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [createFailingAdapter('codex', 'codex parse failed')],
        },
      ),
    ).rejects.toThrow('Failed to parse explicitly requested source(s): codex: codex parse failed');
  });

  it('fails when an explicitly selected fixed-provider source is incompatible with --provider', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          source: 'gemini',
          provider: 'openai',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('gemini', {}, { fixedProviderRoots: ['google'] }),
            createAdapter('codex', {}, { fixedProviderRoots: ['openai'] }),
          ],
        },
      ),
    ).rejects.toThrow(
      'Explicitly requested source(s) are incompatible with the requested --provider scope: gemini.',
    );
  });

  it('fails when an explicit source override is incompatible with inferred model provider scope', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          geminiDir: '/tmp/explicit-gemini',
          model: 'gpt-5.2',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('gemini', {}, { fixedProviderRoots: ['google'] }),
            createAdapter('codex', {}, { fixedProviderRoots: ['openai'] }),
          ],
        },
      ),
    ).rejects.toThrow(
      'Explicitly requested source(s) are incompatible with the requested --model scope: gemini.',
    );
  });

  it('fails when a source with an explicit override flag cannot be parsed', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          codexDir: '/tmp/explicit-codex',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('pi', {
              '/tmp/pi-1.jsonl': [createEvent({ source: 'pi', sessionId: 'pi-session' })],
            }),
            createFailingAdapter('codex', 'permission denied'),
          ],
        },
      ),
    ).rejects.toThrow('Failed to parse explicitly requested source(s): codex: permission denied');
  });

  it('fails when --gemini-dir is set and gemini parsing fails', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          geminiDir: '/tmp/explicit-gemini',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [createFailingAdapter('gemini', 'permission denied')],
        },
      ),
    ).rejects.toThrow('Failed to parse explicitly requested source(s): gemini: permission denied');
  });

  it('fails when --droid-dir is set and droid parsing fails', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          droidDir: '/tmp/explicit-droid',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [createFailingAdapter('droid', 'permission denied')],
        },
      ),
    ).rejects.toThrow('Failed to parse explicitly requested source(s): droid: permission denied');
  });

  it('guards against non-positive parsing concurrency from injected deps', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        getParsingRuntimeConfig: () => ({
          maxParallelFileParsing: 0,
          parseCacheEnabled: false,
          parseCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
          parseCacheMaxEntries: 2_000,
          parseCacheMaxBytes: 64 * 1024 * 1024,
        }),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [createEvent({ source: 'pi', sessionId: 'pi-session' })],
          }),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      {
        source: 'pi',
        filesFound: 1,
        eventsParsed: 1,
      },
    ]);
    expect(result.rows.some((row) => row.rowType === 'period_source')).toBe(true);
  });

  it('guards against fractional parsing concurrency from injected deps', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        getParsingRuntimeConfig: () => ({
          maxParallelFileParsing: 0.5,
          parseCacheEnabled: false,
          parseCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
          parseCacheMaxEntries: 2_000,
          parseCacheMaxBytes: 64 * 1024 * 1024,
        }),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [createEvent({ source: 'pi', sessionId: 'pi-session' })],
          }),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      {
        source: 'pi',
        filesFound: 1,
        eventsParsed: 1,
      },
    ]);
    expect(result.rows.some((row) => row.rowType === 'period_source')).toBe(true);
  });

  it('does not filter providers when no provider filter is passed', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({ source: 'pi', sessionId: 'pi-session', provider: 'anthropic' }),
            ],
          }),
          createAdapter('codex', {
            '/tmp/codex-1.jsonl': [
              createEvent({ source: 'codex', sessionId: 'codex-session', provider: 'openai' }),
            ],
          }),
        ],
      },
    );

    const sourceRows = result.rows.filter((row) => row.rowType === 'period_source');

    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.map((row) => row.source)).toEqual(['pi', 'codex']);
    expect(result.rows.some((row) => row.rowType === 'period_combined')).toBe(true);
  });

  it('filters by model substring when no exact model match exists', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        model: 'claude',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({ model: 'claude-sonnet-4.5', inputTokens: 20, totalTokens: 20 }),
              createEvent({ model: 'claude-opus-4.5', inputTokens: 30, totalTokens: 30 }),
              createEvent({ model: 'gpt-4.1', inputTokens: 40, totalTokens: 40 }),
            ],
          }),
        ],
      },
    );

    const periodRow = result.rows.find((row) => row.rowType === 'period_source');

    expect(periodRow).toMatchObject({
      source: 'pi',
      models: ['claude-opus-4.5', 'claude-sonnet-4.5'],
      totalTokens: 50,
    });
  });

  it('uses exact model matching when an exact model match exists', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        model: 'claude-sonnet-4.5',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({ model: 'claude-sonnet-4.5', inputTokens: 20, totalTokens: 20 }),
              createEvent({ model: 'claude-sonnet-4.5-v2', inputTokens: 30, totalTokens: 30 }),
            ],
          }),
        ],
      },
    );

    const periodRow = result.rows.find((row) => row.rowType === 'period_source');

    expect(periodRow).toMatchObject({
      source: 'pi',
      models: ['claude-sonnet-4.5'],
      totalTokens: 20,
    });
  });

  it('uses substring model matching when exact matches exist only outside selected date range', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        model: 'claude-sonnet-4.5',
        since: '2026-02-14',
        until: '2026-02-14',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({
                timestamp: '2026-02-13T10:00:00.000Z',
                model: 'claude-sonnet-4.5',
                inputTokens: 10,
                totalTokens: 10,
              }),
              createEvent({
                timestamp: '2026-02-14T10:00:00.000Z',
                model: 'claude-sonnet-4.5-v2',
                inputTokens: 30,
                totalTokens: 30,
              }),
            ],
          }),
        ],
      },
    );

    const periodRow = result.rows.find((row) => row.rowType === 'period_source');

    expect(periodRow).toMatchObject({
      source: 'pi',
      models: ['claude-sonnet-4.5-v2'],
      totalTokens: 30,
    });
  });

  it('fails fast on malformed --source-dir values', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          sourceDir: ['missing-separator'],
        },
        {
          ...withDeterministicRuntimeDeps(),
        },
      ),
    ).rejects.toThrow('--source-dir must use format <source-id>=<path>');
  });

  it('validates model filter input', async () => {
    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          model: '   ',
        },
        {
          ...withDeterministicRuntimeDeps(),
        },
      ),
    ).rejects.toThrow('--model must contain at least one non-empty model filter');
  });

  it('trims timezone and pricing-url values before using them', async () => {
    const pricingLoaderSpy = vi.fn(
      async (): Promise<PricingLoadResult> => ({
        source: createDefaultOpenAiPricingSource(),
        origin: 'network',
      }),
    );

    const result = await buildUsageData(
      'daily',
      {
        timezone: ' UTC ',
        pricingUrl: ' https://example.test/pricing.json ',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-pricing-whitespace.jsonl': [
              createEvent({
                source: 'pi',
                costMode: 'estimated',
                costUsd: undefined,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(result.diagnostics.timezone).toBe('UTC');
    expect(pricingLoaderSpy).toHaveBeenCalledTimes(1);
    expect(pricingLoaderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pricingUrl: 'https://example.test/pricing.json',
      }),
      expect.objectContaining({
        cacheTtlMs: 1_000,
        fetchTimeoutMs: 1_000,
      }),
    );
  });

  it.each(['cache', 'network', 'offline-cache'] as const)(
    'records pricing origin "%s" when pricing lookup is required',
    async (origin) => {
      const pricingLoaderSpy = vi.fn(
        async (): Promise<PricingLoadResult> => ({
          source: createDefaultOpenAiPricingSource(),
          origin,
        }),
      );

      const result = await buildUsageData(
        'daily',
        {
          timezone: 'UTC',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('pi', {
              '/tmp/pi-1.jsonl': [
                createEvent({
                  source: 'pi',
                  costMode: 'estimated',
                  costUsd: undefined,
                }),
              ],
            }),
          ],
          resolvePricingSource: pricingLoaderSpy,
        },
      );

      expect(pricingLoaderSpy).toHaveBeenCalledTimes(1);
      expect(result.diagnostics.pricingOrigin).toBe(origin);
    },
  );

  it('keeps pricing origin as none when all events already have explicit cost', async () => {
    const pricingLoaderSpy = vi.fn(
      async (): Promise<PricingLoadResult> => ({
        source: createDefaultOpenAiPricingSource(),
        origin: 'network',
      }),
    );

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({
                source: 'pi',
                costMode: 'explicit',
                costUsd: 0.12,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.pricingOrigin).toBe('none');
  });

  it.each([
    ['--pricing-offline', { pricingOffline: true }],
    ['--pricing-url', { pricingUrl: 'https://example.test/pricing.json' }],
  ] as const)(
    'does not force pricing loading for explicit non-zero costs when %s is set',
    async (_, optionOverrides) => {
      const pricingLoaderSpy = vi.fn(
        async (): Promise<PricingLoadResult> => ({
          source: createDefaultOpenAiPricingSource(),
          origin: 'network',
        }),
      );

      const result = await buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          ...optionOverrides,
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('pi', {
              '/tmp/pi-1.jsonl': [
                createEvent({
                  source: 'pi',
                  costMode: 'explicit',
                  costUsd: 0.12,
                }),
              ],
            }),
          ],
          resolvePricingSource: pricingLoaderSpy,
        },
      );

      expect(pricingLoaderSpy).not.toHaveBeenCalled();
      expect(result.diagnostics.pricingOrigin).toBe('none');
    },
  );

  it('re-prices explicit zero-cost events when model pricing is available', async () => {
    const pricingLoaderSpy = vi.fn(
      async (): Promise<PricingLoadResult> => ({
        source: createDefaultOpenAiPricingSource(),
        origin: 'network',
      }),
    );

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({
                source: 'pi',
                model: 'gpt-4.1',
                costMode: 'explicit',
                costUsd: 0,
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      },
    );

    expect(pricingLoaderSpy).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.pricingOrigin).toBe('network');
    expect(result.rows[0]?.costUsd).toBeGreaterThan(0);
  });

  it('fails when LiteLLM network and cache are unavailable', async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'usage-pricing-no-fallback-'));
    tempDirs.push(cacheRoot);
    process.env.XDG_CACHE_HOME = cacheRoot;

    const fetchSpy = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('pi', {
              '/tmp/pi-1.jsonl': [
                createEvent({
                  source: 'pi',
                  costMode: 'estimated',
                  costUsd: undefined,
                  model: 'gpt-4.1',
                }),
              ],
            }),
          ],
        },
      ),
    ).rejects.toThrow('Could not load LiteLLM pricing');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('continues without estimated pricing when --ignore-pricing-failures is enabled', async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'usage-pricing-ignore-failure-'));
    tempDirs.push(cacheRoot);
    process.env.XDG_CACHE_HOME = cacheRoot;

    const fetchSpy = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
        ignorePricingFailures: true,
      },
      {
        ...withDeterministicRuntimeDeps(),
        createAdapters: () => [
          createAdapter('pi', {
            '/tmp/pi-1.jsonl': [
              createEvent({
                source: 'pi',
                costMode: 'estimated',
                costUsd: undefined,
                model: 'gpt-4.1',
              }),
            ],
          }),
        ],
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.diagnostics.pricingOrigin).toBe('none');
    expect(result.diagnostics.pricingWarning).toContain('Could not load LiteLLM pricing');
    expect(result.rows.at(-1)).toMatchObject({
      rowType: 'grand_total',
      source: 'combined',
      totalTokens: 15,
    });
  });

  it('fails pricing-offline mode when cache is unavailable', async () => {
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'usage-pricing-offline-no-cache-'));
    tempDirs.push(cacheRoot);
    process.env.XDG_CACHE_HOME = cacheRoot;

    const fetchSpy = vi.fn(async () => {
      throw new Error('network should not be called in offline mode');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      buildUsageData(
        'daily',
        {
          timezone: 'UTC',
          pricingOffline: true,
        },
        {
          ...withDeterministicRuntimeDeps(),
          createAdapters: () => [
            createAdapter('pi', {
              '/tmp/pi-1.jsonl': [
                createEvent({
                  source: 'pi',
                  costMode: 'estimated',
                  costUsd: undefined,
                }),
              ],
            }),
          ],
        },
      ),
    ).rejects.toThrow('Offline pricing mode enabled but cached pricing is unavailable');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
