import { describe, expect, it, vi } from 'vitest';

import { buildSessionData } from '../../src/cli/build-session-data.js';
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
    timestamp: '2026-03-05T10:00:00.000Z',
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

describe('buildSessionData', () => {
  it('prices and groups sessions before applying top by sorted cost', async () => {
    const result = await buildSessionData(
      {
        top: '1',
        timezone: 'UTC',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({
                sessionId: 'low-cost',
                inputTokens: 1_000_000,
                outputTokens: 0,
                totalTokens: 1_000_000,
              }),
              createBaseEvent({
                sessionId: 'high-cost',
                inputTokens: 0,
                outputTokens: 1_000_000,
                totalTokens: 1_000_000,
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sessionId: 'high-cost',
      costUsd: 8,
      costIncomplete: undefined,
      outputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    expect(result.diagnostics.pricingOrigin).toBe('cache');
  });

  it('rejects invalid top values before parsing sources', async () => {
    const discoverFiles = vi.fn(async () => ['/tmp/pi.jsonl']);

    await expect(
      buildSessionData(
        {
          top: '0',
          timezone: 'UTC',
        },
        runtimeDeps({
          adapters: [
            {
              id: 'pi',
              discoverFiles,
              parseFile: async () => [],
            },
          ],
        }),
      ),
    ).rejects.toThrow('--top must be a positive integer');

    expect(discoverFiles).not.toHaveBeenCalled();
  });

  it('applies source, date, provider, and model filters before grouping', async () => {
    const result = await buildSessionData(
      {
        source: 'pi',
        since: '2026-03-05',
        until: '2026-03-05',
        provider: 'openai',
        model: 'gpt-4.1',
        timezone: 'UTC',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({
                sessionId: 'included',
                timestamp: '2026-03-05T10:00:00.000Z',
                model: 'gpt-4.1',
              }),
              createBaseEvent({
                sessionId: 'wrong-date',
                timestamp: '2026-03-06T10:00:00.000Z',
                model: 'gpt-4.1',
              }),
              createBaseEvent({
                sessionId: 'wrong-model',
                timestamp: '2026-03-05T10:00:00.000Z',
                model: 'gpt-5-codex',
              }),
              createBaseEvent({
                sessionId: 'wrong-provider',
                timestamp: '2026-03-05T10:00:00.000Z',
                provider: 'anthropic',
                model: 'claude-sonnet-4',
              }),
            ],
          }),
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                source: 'codex',
                sessionId: 'wrong-source',
                timestamp: '2026-03-05T10:00:00.000Z',
                model: 'gpt-4.1',
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.rows.map((row) => row.sessionId)).toEqual(['included']);
  });

  it('continues with incomplete cost rows when pricing fails and failures are ignored', async () => {
    const result = await buildSessionData(
      {
        ignorePricingFailures: true,
        timezone: 'UTC',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [createBaseEvent({ sessionId: 'unpriced' })],
          }),
        ],
        resolvePricingSource: async () => {
          throw new Error('pricing unavailable');
        },
      }),
    );

    expect(result.rows[0]).toMatchObject({
      sessionId: 'unpriced',
      costUsd: undefined,
      costIncomplete: true,
    });
    expect(result.diagnostics.pricingOrigin).toBe('none');
    expect(result.diagnostics.pricingWarning).toContain('pricing unavailable');
  });
});
