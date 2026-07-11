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

function sessionRowsOf(result: Awaited<ReturnType<typeof buildSessionData>>) {
  if (result.grouping !== 'session') {
    throw new Error(`expected session grouping, got ${result.grouping}`);
  }

  return result.rows;
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

    expect(result.grouping).toBe('session');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sessionId: 'high-cost',
      costUsd: 8,
      costIncomplete: undefined,
      outputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    expect(result.limitNote).toBe('Showing top 1 of 2 sessions by cost. Use --top 0 for all.');
    expect(result.diagnostics.pricingOrigin).toBe('cache');
  });

  it('rejects invalid top values before parsing sources', async () => {
    const discoverFiles = vi.fn(async () => ['/tmp/pi.jsonl']);

    await expect(
      buildSessionData(
        {
          top: '-1',
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
    ).rejects.toThrow('--top must be a non-negative integer (0 shows all rows)');

    expect(discoverFiles).not.toHaveBeenCalled();
  });

  it('limits to the top 20 sessions by default and notes the truncation', async () => {
    const events = Array.from({ length: 21 }, (_, index) =>
      createBaseEvent({
        sessionId: `session-${String(index).padStart(2, '0')}`,
        outputTokens: (index + 1) * 1_000,
        inputTokens: 0,
        totalTokens: (index + 1) * 1_000,
      }),
    );

    const result = await buildSessionData(
      { timezone: 'UTC' },
      runtimeDeps({ adapters: [createAdapter('pi', { '/tmp/pi.jsonl': events })] }),
    );

    expect(result.rows).toHaveLength(20);
    expect(result.rows[0]).toMatchObject({ sessionId: 'session-20' });
    expect(sessionRowsOf(result).map((row) => row.sessionId)).not.toContain('session-00');
    expect(result.limitNote).toBe('Showing top 20 of 21 sessions by cost. Use --top 0 for all.');
  });

  it('returns all sessions without a note when top is 0', async () => {
    const events = Array.from({ length: 21 }, (_, index) =>
      createBaseEvent({
        sessionId: `session-${String(index).padStart(2, '0')}`,
        outputTokens: (index + 1) * 1_000,
        inputTokens: 0,
        totalTokens: (index + 1) * 1_000,
      }),
    );

    const result = await buildSessionData(
      { top: '0', timezone: 'UTC' },
      runtimeDeps({ adapters: [createAdapter('pi', { '/tmp/pi.jsonl': events })] }),
    );

    expect(result.rows).toHaveLength(21);
    expect(result.limitNote).toBeUndefined();
  });

  it('filters sessions by id substrings and disables the default limit', async () => {
    const events = Array.from({ length: 25 }, (_, index) =>
      createBaseEvent({ sessionId: `match-${String(index).padStart(2, '0')}` }),
    ).concat([createBaseEvent({ sessionId: 'other-session' })]);

    const result = await buildSessionData(
      { id: ['MATCH,zzz'], timezone: 'UTC' },
      runtimeDeps({ adapters: [createAdapter('pi', { '/tmp/pi.jsonl': events })] }),
    );

    expect(result.rows).toHaveLength(25);
    expect(result.limitNote).toBeUndefined();
    expect(sessionRowsOf(result).every((row) => row.sessionId.startsWith('match-'))).toBe(true);
  });

  it('still applies an explicit top on id matches', async () => {
    const events = ['alpha-1', 'alpha-2', 'alpha-3'].map((sessionId, index) =>
      createBaseEvent({
        sessionId,
        outputTokens: (index + 1) * 1_000,
        inputTokens: 0,
        totalTokens: (index + 1) * 1_000,
      }),
    );

    const result = await buildSessionData(
      { id: ['alpha'], top: '2', timezone: 'UTC' },
      runtimeDeps({ adapters: [createAdapter('pi', { '/tmp/pi.jsonl': events })] }),
    );

    expect(sessionRowsOf(result).map((row) => row.sessionId)).toEqual(['alpha-3', 'alpha-2']);
    expect(result.limitNote).toBe('Showing top 2 of 3 sessions by cost. Use --top 0 for all.');
  });

  it('rejects id filters without a non-empty value before parsing sources', async () => {
    const discoverFiles = vi.fn(async () => ['/tmp/pi.jsonl']);

    await expect(
      buildSessionData(
        { id: [' , '], timezone: 'UTC' },
        runtimeDeps({
          adapters: [{ id: 'pi', discoverFiles, parseFile: async () => [] }],
        }),
      ),
    ).rejects.toThrow('--id must contain at least one non-empty session id filter');

    expect(discoverFiles).not.toHaveBeenCalled();
  });

  it('rejects combining --id with --by-repo before parsing sources', async () => {
    const discoverFiles = vi.fn(async () => ['/tmp/pi.jsonl']);

    await expect(
      buildSessionData(
        { id: ['486c'], byRepo: true, timezone: 'UTC' },
        runtimeDeps({
          adapters: [{ id: 'pi', discoverFiles, parseFile: async () => [] }],
        }),
      ),
    ).rejects.toThrow('--id cannot be combined with --by-repo');

    expect(discoverFiles).not.toHaveBeenCalled();
  });

  it('groups by repo root with a repos limit note when by-repo is set', async () => {
    const result = await buildSessionData(
      { byRepo: true, top: '1', timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({
                sessionId: 'expensive',
                outputTokens: 1_000_000,
                inputTokens: 0,
                totalTokens: 1_000_000,
                repoRoot: '/home/user/project-a',
              }),
              createBaseEvent({ sessionId: 'cheap' }),
            ],
          }),
        ],
      }),
    );

    expect(result.grouping).toBe('repo');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      rowType: 'repo',
      repoRoot: '/home/user/project-a',
      sessionCount: 1,
      sources: ['pi'],
      costUsd: 8,
    });
    expect(result.limitNote).toBe('Showing top 1 of 2 repos by cost. Use --top 0 for all.');
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

    expect(sessionRowsOf(result).map((row) => row.sessionId)).toEqual(['included']);
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
