import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCompareData, resolveCompareWindows } from '../../src/cli/build-compare-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { EventStoreHistoryResult } from '../../src/persistence/event-store-history.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
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

function createBaseEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-03-01T12:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 0.03,
    ...overrides,
  });
}

function runtimeDeps(
  overrides: {
    adapters?: SourceAdapter[];
    eventStorePath?: string;
    loadHistoryEvents?: () => EventStoreHistoryResult;
    resolvePricingSource?: () => Promise<PricingLoadResult>;
    now?: () => Date;
  } = {},
) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 2,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({
      enabled: overrides.eventStorePath !== undefined,
      path: overrides.eventStorePath ?? '/tmp/events.db',
    }),
    getActiveEnvVarOverrides: () => [],
    createAdapters: () => overrides.adapters ?? [],
    loadHistoryEvents: overrides.loadHistoryEvents,
    resolvePricingSource: overrides.resolvePricingSource,
    now: overrides.now,
  };
}

async function createEventStorePath(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'compare-history-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'events.db');
}

function metric(result: Awaited<ReturnType<typeof buildCompareData>>, key: string) {
  const row = result.totals.find((candidate) => candidate.key === key);

  if (!row) {
    throw new Error(`Missing compare metric: ${key}`);
  }

  return row;
}

describe('resolveCompareWindows', () => {
  it('defaults to current and previous calendar month across a year boundary', () => {
    const windows = resolveCompareWindows({}, 'UTC', new Date('2026-01-15T12:00:00.000Z'));

    expect(windows.current).toEqual({
      since: '2026-01-01',
      until: '2026-01-31',
      label: '2026-01',
    });
    expect(windows.baseline).toEqual({
      since: '2025-12-01',
      until: '2025-12-31',
      label: '2025-12',
    });
    expect(windows.combined).toEqual({ since: '2025-12-01', until: '2026-01-31' });
  });

  it('resolves an explicit range against the preceding equal-length range', () => {
    const windows = resolveCompareWindows(
      { since: '2026-01-01', until: '2026-01-31' },
      'UTC',
      new Date('2026-07-01T12:00:00.000Z'),
    );

    expect(windows.current).toEqual({
      since: '2026-01-01',
      until: '2026-01-31',
      label: '2026-01',
    });
    expect(windows.baseline).toEqual({
      since: '2025-12-01',
      until: '2025-12-31',
      label: '2025-12',
    });
  });
});

describe('buildCompareData', () => {
  it('splits events using timezone-aware local dates', async () => {
    const result = await buildCompareData(
      {
        timezone: 'America/Los_Angeles',
        since: '2026-03-01',
        until: '2026-03-01',
      },
      runtimeDeps({
        adapters: [
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                timestamp: '2026-03-01T07:30:00.000Z',
                inputTokens: 10,
                outputTokens: 0,
                totalTokens: 10,
              }),
              createBaseEvent({
                timestamp: '2026-03-01T08:30:00.000Z',
                inputTokens: 20,
                outputTokens: 0,
                totalTokens: 20,
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.current.window).toMatchObject({ since: '2026-03-01', until: '2026-03-01' });
    expect(result.baseline.window).toMatchObject({ since: '2026-02-28', until: '2026-02-28' });
    expect(result.current.totals.totalTokens).toBe(20);
    expect(result.baseline.totals.totalTokens).toBe(10);
  });

  it('excludes events in the gap between explicit disjoint windows', async () => {
    const result = await buildCompareData(
      {
        timezone: 'UTC',
        since: '2026-03-10',
        until: '2026-03-10',
        vsSince: '2026-02-01',
        vsUntil: '2026-02-01',
      },
      runtimeDeps({
        adapters: [
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                timestamp: '2026-02-01T12:00:00.000Z',
                inputTokens: 10,
                outputTokens: 0,
                totalTokens: 10,
              }),
              createBaseEvent({
                timestamp: '2026-02-15T12:00:00.000Z',
                inputTokens: 100,
                outputTokens: 0,
                totalTokens: 100,
              }),
              createBaseEvent({
                timestamp: '2026-03-10T12:00:00.000Z',
                inputTokens: 20,
                outputTokens: 0,
                totalTokens: 20,
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.current.totals).toMatchObject({ events: 1, totalTokens: 20 });
    expect(result.baseline.totals).toMatchObject({ events: 1, totalTokens: 10 });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      source: 'codex',
      current: { events: 1, totalTokens: 20 },
      baseline: { events: 1, totalTokens: 10 },
    });
  });

  it('uses undefined delta percent for non-zero current over a zero baseline', async () => {
    const result = await buildCompareData(
      {
        timezone: 'UTC',
        since: '2026-04-01',
        until: '2026-04-01',
      },
      runtimeDeps({
        adapters: [
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                timestamp: '2026-04-01T12:00:00.000Z',
                inputTokens: 10,
                outputTokens: 0,
                totalTokens: 10,
              }),
            ],
          }),
        ],
      }),
    );

    expect(metric(result, 'totalTokens')).toMatchObject({
      current: 10,
      baseline: 0,
      delta: 10,
      deltaPercent: undefined,
    });
    expect(metric(result, 'reasoningTokens')).toMatchObject({
      current: 0,
      baseline: 0,
      delta: 0,
      deltaPercent: 0,
    });
  });

  it('applies source, provider, and model filters to both windows', async () => {
    const result = await buildCompareData(
      {
        timezone: 'UTC',
        source: 'codex',
        provider: 'openai',
        model: 'gpt-4.1',
        since: '2026-03-10',
        until: '2026-03-10',
        vsSince: '2026-03-09',
        vsUntil: '2026-03-09',
      },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({
                source: 'pi',
                timestamp: '2026-03-10T12:00:00.000Z',
                inputTokens: 100,
                totalTokens: 100,
              }),
            ],
          }),
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                timestamp: '2026-03-09T12:00:00.000Z',
                inputTokens: 10,
                outputTokens: 0,
                totalTokens: 10,
              }),
              createBaseEvent({
                timestamp: '2026-03-10T12:00:00.000Z',
                inputTokens: 20,
                outputTokens: 0,
                totalTokens: 20,
              }),
              createBaseEvent({
                timestamp: '2026-03-10T12:00:01.000Z',
                provider: 'anthropic',
                model: 'claude-sonnet-4.5',
                inputTokens: 100,
                outputTokens: 0,
                totalTokens: 100,
              }),
              createBaseEvent({
                timestamp: '2026-03-10T12:00:02.000Z',
                model: 'gpt-4.1-mini',
                inputTokens: 100,
                outputTokens: 0,
                totalTokens: 100,
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.current.totals).toMatchObject({ events: 1, totalTokens: 20 });
    expect(result.baseline.totals).toMatchObject({ events: 1, totalTokens: 10 });
    expect(result.sources.map((row) => row.source)).toEqual(['codex']);
  });

  it('passes --history through to the shared dataset builder', async () => {
    const eventStorePath = await createEventStorePath();
    const loadHistoryEvents = vi.fn(() => ({
      events: [],
      departedFileCount: 0,
      servedEventCount: 0,
      servedFileCount: 0,
      suppressedFileCount: 0,
    }));

    await buildCompareData(
      {
        history: true,
        source: 'codex',
        timezone: 'UTC',
        since: '2026-02-01',
        until: '2026-02-01',
      },
      runtimeDeps({
        eventStorePath,
        adapters: [createAdapter('codex', {})],
        loadHistoryEvents,
      }),
    );

    expect(loadHistoryEvents).toHaveBeenCalledWith(expect.anything(), {
      selectedSources: ['codex'],
      discoveredFiles: [],
    });
  });
});
