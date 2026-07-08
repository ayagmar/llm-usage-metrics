import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import { loadHistoryEvents } from '../../src/persistence/event-store-history.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
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
    costMode: 'explicit',
    costUsd: 0.03,
    ...overrides,
  });
}

function createFingerprint(filePath: string): EventStoreFileFingerprint {
  return {
    dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }],
  };
}

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

function createDatasetDeps(eventStorePath: string) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 1,
      parseWorkers: 0,
      parseWorkerMinBytes: 268_435_456,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({ enabled: true, path: eventStorePath }),
    getActiveEnvVarOverrides: () => [],
  };
}

async function createEventStorePath(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-event-dataset-history-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'events.db');
}

async function writeStoredFile(
  eventStorePath: string,
  options: {
    source?: string;
    filePath: string;
    events: ReturnType<typeof createEvent>[];
  },
): Promise<void> {
  const store = await openEventStore(eventStorePath);

  try {
    replaceFileEvents(store, {
      source: options.source ?? 'codex',
      filePath: options.filePath,
      fingerprint: createFingerprint(options.filePath),
      events: options.events,
      skippedRows: 0,
      now: 1_000,
    });
  } finally {
    closeEventStore(store);
  }
}

describe('buildUsageEventDataset history', () => {
  it('applies source config below an explicit source flag', async () => {
    const codexEvent = createEvent({ source: 'codex', sessionId: 'codex-config' });
    const piEvent = createEvent({ source: 'pi', sessionId: 'pi-flag' });
    const loadedConfig = {
      config: {
        sources: ['codex'],
      },
      path: '/tmp/config.json',
      exists: true,
      warnings: [],
    };
    const deps = {
      ...createDatasetDeps('/tmp/events.db'),
      createAdapters: () => [
        createAdapter('pi', { '/tmp/pi.jsonl': [piEvent] }),
        createAdapter('codex', { '/tmp/codex.jsonl': [codexEvent] }),
      ],
      loadUserConfig: async () => loadedConfig,
    };

    const configuredDataset = await buildUsageEventDataset({ timezone: 'UTC' }, deps);
    const flagDataset = await buildUsageEventDataset({ source: 'pi', timezone: 'UTC' }, deps);

    expect(configuredDataset.filteredEvents).toEqual([codexEvent]);
    expect(configuredDataset.activeConfig).toEqual({
      path: '/tmp/config.json',
      entries: [{ key: 'sources', value: 'codex' }],
    });
    expect(flagDataset.filteredEvents).toEqual([piEvent]);
    expect(flagDataset.activeConfig).toBeUndefined();
  });

  it('does not call the history loader when --history is off', async () => {
    const eventStorePath = await createEventStorePath();
    const loadHistoryEvents = vi.fn();

    const dataset = await buildUsageEventDataset(
      { source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
        loadHistoryEvents,
      },
    );

    expect(loadHistoryEvents).not.toHaveBeenCalled();
    expect(dataset.filteredEvents).toEqual([]);
    expect(dataset.warnings).toEqual([]);
  });

  it('rejects --history when the event store is disabled by env config', async () => {
    await expect(
      buildUsageEventDataset(
        { history: true, source: 'codex', timezone: 'UTC' },
        {
          ...createDatasetDeps('/tmp/events.db'),
          getEventStoreRuntimeConfig: () => ({ enabled: false, path: '/tmp/events.db' }),
          createAdapters: () => [createAdapter('codex', {})],
        },
      ),
    ).rejects.toThrow('--history requires the event store (unset LLM_USAGE_EVENT_STORE=0)');
  });

  it('emits a zero history diagnostic when no departed files are found', async () => {
    const eventStorePath = await createEventStorePath();

    const dataset = await buildUsageEventDataset(
      { history: true, source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
      },
    );

    expect(dataset.filteredEvents).toEqual([]);
    expect(dataset.warnings).toEqual([
      'History: included 0 event(s) from 0 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });

  it('excludes sources whose parse failed from history loading', async () => {
    const eventStorePath = await createEventStorePath();
    await writeStoredFile(eventStorePath, {
      source: 'pi',
      filePath: '/tmp/pi-departed.jsonl',
      events: [createEvent({ source: 'pi', sessionId: 'pi-departed' })],
    });
    const failingAdapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => {
        throw new Error('pi discovery failed');
      },
      parseFile: async () => [],
    };
    const loadHistoryEventsSpy = vi.fn(loadHistoryEvents);

    const dataset = await buildUsageEventDataset(
      { history: true, timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {}), failingAdapter],
        loadHistoryEvents: loadHistoryEventsSpy,
      },
    );

    expect(loadHistoryEventsSpy).toHaveBeenCalledWith(expect.anything(), {
      selectedSources: ['codex'],
      discoveredFiles: [],
    });
    expect(dataset.sourceFailures).toEqual([{ source: 'pi', reason: 'pi discovery failed' }]);
    expect(dataset.filteredEvents).toEqual([]);
    expect(dataset.warnings).toEqual([
      'History: included 0 event(s) from 0 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });

  it('applies provider, model, and date filters to served history events', async () => {
    const eventStorePath = await createEventStorePath();
    const matchingEvent = createEvent({ sessionId: 'matching' });
    await writeStoredFile(eventStorePath, {
      filePath: '/tmp/departed.jsonl',
      events: [
        matchingEvent,
        createEvent({
          sessionId: 'wrong-provider',
          provider: 'anthropic',
          model: 'claude-sonnet-4.5',
        }),
        createEvent({
          sessionId: 'wrong-date',
          timestamp: '2026-02-15T10:00:00.000Z',
        }),
      ],
    });

    const dataset = await buildUsageEventDataset(
      {
        history: true,
        source: 'codex',
        timezone: 'UTC',
        provider: 'openai',
        model: 'gpt-4.1',
        since: '2026-02-14',
        until: '2026-02-14',
      },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
      },
    );

    expect(dataset.filteredEvents).toEqual([matchingEvent]);
    expect(dataset.warnings).toEqual([
      'History: included 3 event(s) from 1 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });
});
