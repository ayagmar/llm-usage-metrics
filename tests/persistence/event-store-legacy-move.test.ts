import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  getDefaultEventStorePath,
  getLegacyEventStorePath,
  openEventStore,
  readEventStoreStoredFiles,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-legacy-move-'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(rootDir, 'cache'));
  vi.stubEnv('XDG_DATA_HOME', path.join(rootDir, 'data'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

async function writeStore(filePath: string, storedFilePath: string): Promise<void> {
  const store = await openEventStore(filePath);
  replaceFileEvents(store, {
    source: 'codex',
    filePath: storedFilePath,
    fingerprint: { dependencies: [{ path: storedFilePath, exists: true, size: 10, mtimeMs: 20 }] },
    events: [
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-1',
        timestamp: '2026-02-01T00:00:00.000Z',
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costMode: 'estimated',
      }),
    ],
    skippedRows: 0,
    now: 1_000,
  });
  closeEventStore(store);
}

describe('legacy event store copy', () => {
  it('keeps the ledger in the data directory, not the cache directory', () => {
    expect(getDefaultEventStorePath()).toBe(
      path.join(rootDir, 'data', 'llm-usage-metrics', 'events.db'),
    );
    expect(getLegacyEventStorePath()).toBe(
      path.join(rootDir, 'cache', 'llm-usage-metrics', 'events.db'),
    );
  });

  it('copies a ledger left in the cache directory by an older version on first open', async () => {
    await writeStore(getLegacyEventStorePath(), '/tmp/departed.jsonl');

    closeEventStore(await openEventStore());

    await expect(readEventStoreStoredFiles(getDefaultEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/departed.jsonl' },
    ]);
    // An older version may still write to the old ledger, so it is kept, never deleted.
    await expect(readEventStoreStoredFiles(getLegacyEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/departed.jsonl' },
    ]);
    await expect(readdir(path.dirname(getDefaultEventStorePath()))).resolves.not.toContainEqual(
      expect.stringMatching(/\.tmp$/u),
    );
  });

  it('never overwrites a ledger that already exists in the data directory', async () => {
    await writeStore(getDefaultEventStorePath(), '/tmp/current.jsonl');
    await writeStore(getLegacyEventStorePath(), '/tmp/legacy.jsonl');

    closeEventStore(await openEventStore());

    await expect(readEventStoreStoredFiles(getDefaultEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/current.jsonl' },
    ]);
    await expect(readEventStoreStoredFiles(getLegacyEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/legacy.jsonl' },
    ]);
  });

  it('leaves the legacy ledger alone when a custom store path is used', async () => {
    await writeStore(getLegacyEventStorePath(), '/tmp/legacy.jsonl');

    closeEventStore(await openEventStore(path.join(rootDir, 'custom', 'events.db')));

    await expect(readEventStoreStoredFiles(getLegacyEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/legacy.jsonl' },
    ]);
  });

  it('opens the ledger in place when the cache and data roots are the same directory', async () => {
    vi.stubEnv('XDG_DATA_HOME', path.join(rootDir, 'cache'));
    await writeStore(getLegacyEventStorePath(), '/tmp/same-root.jsonl');

    closeEventStore(await openEventStore());

    await expect(readEventStoreStoredFiles(getDefaultEventStorePath())).resolves.toEqual([
      { source: 'codex', filePath: '/tmp/same-root.jsonl' },
    ]);
  });

  it('keeps an unreadable legacy ledger and leaves no snapshot behind', async () => {
    await mkdir(path.dirname(getLegacyEventStorePath()), { recursive: true });
    await writeFile(getLegacyEventStorePath(), 'not a sqlite database');

    await expect(openEventStore()).rejects.toThrow();

    await expect(readFile(getLegacyEventStorePath(), 'utf8')).resolves.toBe(
      'not a sqlite database',
    );
    await expect(readdir(path.dirname(getDefaultEventStorePath()))).resolves.toEqual([]);
  });

  it('does not copy the old ledger again after the copied one is deleted', async () => {
    await writeStore(getLegacyEventStorePath(), '/tmp/pruned-later.jsonl');
    closeEventStore(await openEventStore());

    // A reset: the user deletes the copied ledger, e.g. after pruning it.
    await rm(getDefaultEventStorePath());
    closeEventStore(await openEventStore());

    await expect(readEventStoreStoredFiles(getDefaultEventStorePath())).resolves.toEqual([]);
  });
});
