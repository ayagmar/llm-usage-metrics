import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
    getEventStoreRuntimeConfig: () => ({ enabled: true as const, path: eventStorePath }),
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
      path: '/tmp/config.toml',
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
      path: '/tmp/config.toml',
      entries: [{ key: 'sources', value: 'codex' }],
    });
    expect(flagDataset.filteredEvents).toEqual([piEvent]);
    expect(flagDataset.activeConfig).toBeUndefined();
  });

  it('does not treat config source dirs as explicit requests under a provider filter', async () => {
    const codexEvent = createEvent({
      source: 'codex',
      sessionId: 'codex-openai',
      provider: 'openai',
    });
    const loadedConfig = {
      config: {
        sourceDirs: { gemini: '/tmp/config-gemini' },
      },
      path: '/tmp/config.toml',
      exists: true,
      warnings: [],
    };
    const geminiAdapter: SourceAdapter = {
      ...createAdapter('gemini', {}),
      capabilities: { fixedProviderRoots: ['google'] },
    };
    const deps = {
      ...createDatasetDeps('/tmp/events.db'),
      createAdapters: () => [
        geminiAdapter,
        createAdapter('codex', { '/tmp/codex.jsonl': [codexEvent] }),
      ],
      loadUserConfig: async () => loadedConfig,
    };

    const dataset = await buildUsageEventDataset({ provider: 'openai', timezone: 'UTC' }, deps);

    expect(dataset.filteredEvents).toEqual([codexEvent]);
    await expect(
      buildUsageEventDataset(
        { provider: 'openai', timezone: 'UTC', geminiDir: '/tmp/flag-gemini' },
        deps,
      ),
    ).rejects.toThrow('Explicitly requested source(s) are incompatible');
  });

  it('does not call the history loader with --no-history', async () => {
    const eventStorePath = await createEventStorePath();
    const loadHistoryEvents = vi.fn();

    const dataset = await buildUsageEventDataset(
      { history: false, source: 'codex', timezone: 'UTC' },
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

  it('includes history by default', async () => {
    const eventStorePath = await createEventStorePath();
    const loadHistoryEventsSpy = vi.fn(loadHistoryEvents);

    const dataset = await buildUsageEventDataset(
      { source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
        loadHistoryEvents: loadHistoryEventsSpy,
      },
    );

    expect(loadHistoryEventsSpy).toHaveBeenCalledTimes(1);
    // Nothing departed, so the default run adds no stderr note.
    expect(dataset.notes).toEqual([]);
  });

  it('skips default history quietly when the event store is disabled', async () => {
    const loadHistoryEventsSpy = vi.fn(loadHistoryEvents);

    const dataset = await buildUsageEventDataset(
      { source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps('/tmp/events.db'),
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '/tmp/events.db',
          disabledBy: 'environment',
        }),
        createAdapters: () => [createAdapter('codex', {})],
        loadHistoryEvents: loadHistoryEventsSpy,
      },
    );

    expect(loadHistoryEventsSpy).not.toHaveBeenCalled();
    expect(dataset.warnings).toEqual([]);
  });

  it('leaves default history out for a source pointed at a custom directory', async () => {
    const eventStorePath = await createEventStorePath();
    const loadHistoryEventsSpy = vi.fn(loadHistoryEvents);
    const deps = {
      ...createDatasetDeps(eventStorePath),
      createAdapters: () => [createAdapter('codex', {})],
      loadHistoryEvents: loadHistoryEventsSpy,
    };

    await buildUsageEventDataset({ codexDir: '/tmp/export', timezone: 'UTC' }, deps);
    expect(loadHistoryEventsSpy).not.toHaveBeenCalled();

    await buildUsageEventDataset({ codexDir: '/tmp/export', history: true, timezone: 'UTC' }, deps);
    expect(loadHistoryEventsSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects --history when the event store is disabled by env config', async () => {
    await expect(
      buildUsageEventDataset(
        { history: true, source: 'codex', timezone: 'UTC' },
        {
          ...createDatasetDeps('/tmp/events.db'),
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: '/tmp/events.db',
            disabledBy: 'environment',
          }),
          createAdapters: () => [createAdapter('codex', {})],
        },
      ),
    ).rejects.toThrow('--history requires the event store (unset LLM_USAGE_EVENT_STORE=0)');
  });

  it('rejects --history when the event store is disabled by config', async () => {
    await expect(
      buildUsageEventDataset(
        { history: true, source: 'codex', timezone: 'UTC' },
        {
          ...createDatasetDeps('/tmp/events.db'),
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: '/tmp/events.db',
            disabledBy: 'configuration',
          }),
          createAdapters: () => [createAdapter('codex', {})],
        },
      ),
    ).rejects.toThrow(
      '--history requires the event store (set eventStore.enabled = true in config.toml)',
    );
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
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
      'History: included 0 event(s) from 0 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });

  it('opens the event store once across parsing and history loading', async () => {
    const eventStorePath = await createEventStorePath();
    const openEventStoreSpy = vi.fn(openEventStore);
    const closeEventStoreSpy = vi.fn(closeEventStore);

    const dataset = await buildUsageEventDataset(
      { history: true, source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
        openEventStore: openEventStoreSpy,
        closeEventStore: closeEventStoreSpy,
      },
    );

    expect(dataset.filteredEvents).toEqual([]);
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
      'History: included 0 event(s) from 0 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
    expect(openEventStoreSpy).toHaveBeenCalledTimes(1);
    expect(openEventStoreSpy).toHaveBeenCalledWith(eventStorePath);
    expect(closeEventStoreSpy).toHaveBeenCalledTimes(1);
  });

  async function createUnopenableEventStorePath(): Promise<{ parent: string; path: string }> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-event-dataset-open-failure-'));
    tempDirs.push(tempDir);
    const eventStoreParentPath = path.join(tempDir, 'not-a-dir');
    await writeFile(eventStoreParentPath, 'not a directory', 'utf8');
    return { parent: eventStoreParentPath, path: path.join(eventStoreParentPath, 'events.db') };
  }

  it('fails --history with the reason when the event store cannot be opened', async () => {
    const eventStore = await createUnopenableEventStorePath();
    const loadHistoryEventsSpy = vi.fn(loadHistoryEvents);

    await expect(
      buildUsageEventDataset(
        { history: true, source: 'codex', timezone: 'UTC' },
        {
          ...createDatasetDeps(eventStore.path),
          createAdapters: () => [createAdapter('codex', { '/tmp/codex.jsonl': [createEvent()] })],
          loadHistoryEvents: loadHistoryEventsSpy,
        },
      ),
    ).rejects.toThrow(
      `--history could not open the event store at ${eventStore.path}: EEXIST: file already exists, mkdir '${eventStore.parent}'`,
    );
    expect(loadHistoryEventsSpy).not.toHaveBeenCalled();
  });

  it('warns and parses without the store when it cannot be opened', async () => {
    const eventStore = await createUnopenableEventStorePath();
    const event = createEvent();

    const dataset = await buildUsageEventDataset(
      { source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStore.path),
        createAdapters: () => [createAdapter('codex', { '/tmp/codex.jsonl': [event] })],
      },
    );

    expect(dataset.filteredEvents).toEqual([event]);
    expect(dataset.warnings).toEqual([
      `Event store disabled after failure: EEXIST: file already exists, mkdir '${eventStore.parent}'`,
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
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
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
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
      'History: included 3 event(s) from 1 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });

  it('does not serve undiscovered files that are still on disk as history', async () => {
    const eventStorePath = await createEventStorePath();
    const onDiskPath = path.join(path.dirname(eventStorePath), 'outside-discovery.jsonl');
    const departedPath = path.join(path.dirname(eventStorePath), 'departed.jsonl');
    await writeFile(onDiskPath, '{}\n', 'utf8');
    await writeStoredFile(eventStorePath, {
      filePath: onDiskPath,
      events: [createEvent({ sessionId: 'on-disk' })],
    });
    const departedEvent = createEvent({ sessionId: 'departed' });
    await writeStoredFile(eventStorePath, { filePath: departedPath, events: [departedEvent] });

    const dataset = await buildUsageEventDataset(
      { history: true, source: 'codex', timezone: 'UTC' },
      {
        ...createDatasetDeps(eventStorePath),
        createAdapters: () => [createAdapter('codex', {})],
      },
    );

    expect(dataset.filteredEvents).toEqual([departedEvent]);
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
      'History: included 1 event(s) from 1 departed file(s) (0 suppressed as moved or duplicated).',
    ]);
  });

  it('does not treat a file skipped by --since as departed', async () => {
    const eventStorePath = await createEventStorePath();
    const liveFilePath = path.join(path.dirname(eventStorePath), 'live.jsonl');
    const departedFilePath = path.join(path.dirname(eventStorePath), 'departed.jsonl');
    await writeFile(liveFilePath, '{}\n', 'utf8');
    const beforeWindowSeconds = Date.parse('2026-02-01T00:00:00.000Z') / 1000;
    await utimes(liveFilePath, beforeWindowSeconds, beforeWindowSeconds);

    // The stored event sits inside the window only so a wrongly departed file would show.
    const liveEvent = createEvent({ sessionId: 'live' });
    const departedEvent = createEvent({ sessionId: 'departed' });
    const parseFile = vi.fn(async () => [liveEvent]);
    const adapter: SourceAdapter = {
      id: 'codex',
      capabilities: { eventsPrecedeFileMtime: true },
      discoverFiles: async () => [liveFilePath],
      parseFile,
    };
    const deps = { ...createDatasetDeps(eventStorePath), createAdapters: () => [adapter] };

    await buildUsageEventDataset({ source: 'codex', timezone: 'UTC' }, deps);
    await writeStoredFile(eventStorePath, { filePath: departedFilePath, events: [departedEvent] });
    // A departed copy of the skipped file is suppressed only while the skipped file still
    // counts as discovered; as a merely present file it would be served again.
    await writeStoredFile(eventStorePath, {
      filePath: path.join(path.dirname(eventStorePath), 'moved-away.jsonl'),
      events: [liveEvent],
    });

    const dataset = await buildUsageEventDataset(
      { history: true, since: '2026-02-10', source: 'codex', timezone: 'UTC' },
      deps,
    );

    expect(parseFile).toHaveBeenCalledTimes(1);
    expect(dataset.filteredEvents).toEqual([departedEvent]);
    expect(dataset.warnings).toEqual([]);
    expect(dataset.notes).toEqual([
      'History: included 1 event(s) from 1 departed file(s) (1 suppressed as moved or duplicated).',
    ]);
  });
});
