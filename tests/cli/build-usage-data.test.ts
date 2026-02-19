import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createDefaultOpenAiPricingSource } from '../../src/pricing/static-pricing-source.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

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
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
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
    getParsingRuntimeConfig: () => ({ maxParallelFileParsing: 2 }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getActiveEnvVarOverrides: () => [],
  };
}

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
            },
          }),
        ],
      },
    );

    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'opencode', filesFound: 1, eventsParsed: 1 },
    ]);
    expect(result.diagnostics.skippedRows).toEqual([{ source: 'opencode', skippedRows: 2 }]);
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

  it('guards against non-positive parsing concurrency from injected deps', async () => {
    const result = await buildUsageData(
      'daily',
      {
        timezone: 'UTC',
      },
      {
        ...withDeterministicRuntimeDeps(),
        getParsingRuntimeConfig: () => ({ maxParallelFileParsing: 0 }),
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
        getParsingRuntimeConfig: () => ({ maxParallelFileParsing: 0.5 }),
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

  it('falls back to substring model matching when exact model exists only outside selected date range', async () => {
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

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
