import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { buildPruneReport } from '../../src/cli/run-prune-report.js';
import type { UsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  getDefaultEventStorePath,
  openEventStore,
  readFileEvents,
  replaceFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';

type PathSnapshot =
  | {
      exists: false;
    }
  | {
      exists: true;
      size: number;
      mtimeMs: number;
    };

const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const liveFilePath = path.join(claudeDir, 'e2e-project', 'session.jsonl');
const departedFilePath = path.join(claudeDir, 'e2e-project', 'departed-session.jsonl');
const defaultStorePath = getDefaultEventStorePath();

let tempDir: string;
let storePath: string;
let previousEventStore: string | undefined;
let previousEventStorePath: string | undefined;
let defaultStoreBefore: PathSnapshot;

async function getPathSnapshot(filePath: string): Promise<PathSnapshot> {
  try {
    const stats = await stat(filePath);

    return {
      exists: true,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { exists: false };
    }

    throw error;
  }
}

function createFingerprint(filePath: string): EventStoreFileFingerprint {
  return {
    dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }],
  };
}

function writeStoredFile(
  store: EventStore,
  options: {
    filePath: string;
    events: UsageEvent[];
    now: number;
  },
): void {
  replaceFileEvents(store, {
    source: 'claude',
    filePath: options.filePath,
    fingerprint: createFingerprint(options.filePath),
    events: options.events,
    skippedRows: 0,
    now: options.now,
  });
}

// A report ingests the live fixture; the departed file is an earlier copy of it.
async function seedStore(): Promise<void> {
  await buildUsageData('daily', {
    all: true,
    source: 'claude',
    claudeDir,
    timezone: 'UTC',
    pricingOffline: true,
  });
  const store = await openEventStore(storePath);

  try {
    writeStoredFile(store, {
      filePath: departedFilePath,
      events: readFileEvents(store, 'claude', liveFilePath) ?? [],
      now: 1_000,
    });
  } finally {
    closeEventStore(store);
  }
}

async function readStoredEvents(filePath: string): Promise<UsageEvent[] | undefined> {
  const store = await openEventStore(storePath);

  try {
    return readFileEvents(store, 'claude', filePath);
  } finally {
    closeEventStore(store);
  }
}

beforeAll(async () => {
  defaultStoreBefore = await getPathSnapshot(defaultStorePath);
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'prune-e2e-'));
  storePath = path.join(tempDir, 'prune-e2e.db');
  previousEventStore = process.env.LLM_USAGE_EVENT_STORE;
  previousEventStorePath = process.env.LLM_USAGE_EVENT_STORE_PATH;
  process.env.LLM_USAGE_EVENT_STORE = '1';
  process.env.LLM_USAGE_EVENT_STORE_PATH = storePath;
});

afterAll(async () => {
  const defaultStoreAfter = await getPathSnapshot(defaultStorePath);

  expect(defaultStoreAfter).toEqual(defaultStoreBefore);

  if (previousEventStore === undefined) {
    delete process.env.LLM_USAGE_EVENT_STORE;
  } else {
    process.env.LLM_USAGE_EVENT_STORE = previousEventStore;
  }

  if (previousEventStorePath === undefined) {
    delete process.env.LLM_USAGE_EVENT_STORE_PATH;
  } else {
    process.env.LLM_USAGE_EVENT_STORE_PATH = previousEventStorePath;
  }

  await rm(tempDir, { recursive: true, force: true });
});

describe('prune report e2e', () => {
  it('keeps departed rows during a dry run', async () => {
    await seedStore();

    const result = await buildPruneReport({
      source: 'claude',
      claudeDir,
      suppressed: true,
    });

    expect(result.summary).toMatchObject({
      storePath,
      applied: false,
      candidateFileCount: 1,
      candidateEventCount: 2,
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source: 'claude',
        filePath: departedFilePath,
        eventCount: 2,
        newestTimestamp: '2026-06-20T12:05:00.000Z',
        reasons: ['suppressed'],
      }),
    ]);
    expect(await readStoredEvents(departedFilePath)).toHaveLength(2);
    expect(await readStoredEvents(liveFilePath)).toHaveLength(2);
  });

  it('deletes only departed rows when apply is enabled', async () => {
    await seedStore();

    const result = await buildPruneReport({
      source: 'claude',
      claudeDir,
      suppressed: true,
      apply: true,
    });

    expect(result.summary).toMatchObject({
      storePath,
      applied: true,
      candidateFileCount: 1,
      candidateEventCount: 2,
      deletedFileCount: 1,
      deletedEventCount: 2,
    });
    expect(await readStoredEvents(departedFilePath)).toEqual([]);
    expect(await readStoredEvents(liveFilePath)).toHaveLength(2);
  });

  it('rejects prune without a selector', async () => {
    await expect(buildPruneReport({ source: 'claude', claudeDir })).rejects.toThrow(
      'prune requires at least one selector: --suppressed or --departed-before',
    );
  });
});
