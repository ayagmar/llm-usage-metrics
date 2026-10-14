import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';
import { CodexSourceAdapter } from '../../src/sources/codex/codex-source-adapter.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  captureStdout,
  expectGolden,
  FIXED_GOLDENS,
  fixedNow,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');

async function storeDepartedFile(
  dbPath: string,
  filePath: string,
  events: UsageEvent[],
): Promise<void> {
  const store = await openEventStore(dbPath);

  try {
    replaceFileEvents(store, {
      source: 'codex',
      filePath,
      fingerprint: { dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }] },
      events,
      skippedRows: 0,
      now: 1_000,
    });
  } finally {
    closeEventStore(store);
  }
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`history goldens (${WINDOWS_SKIP_REASON})`, () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck();
  const sources = { piDir, codexDir, source: 'pi,codex', timezone: 'UTC', pricingOffline: true };

  beforeAll(async () => {
    freezeDate();
    const storeDir = path.join(environment.rootDir, 'store');
    const dbPath = path.join(storeDir, 'events.db');
    await mkdir(storeDir);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', dbPath);

    // A departed codex file with usage no live file has: history serves it.
    await storeDepartedFile(dbPath, path.join(environment.rootDir, 'departed', 'old.jsonl'), [
      createUsageEvent({
        source: 'codex',
        sessionId: 'golden-departed-session',
        timestamp: '2025-01-01T00:00:00.000Z',
        model: 'gpt-4.1',
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      }),
    ]);
    // A departed copy of the live codex session, as left by a moved file: history
    // suppresses it so the session is counted once.
    const liveCodexEvents = await new CodexSourceAdapter({ dir: codexDir }).parseFile(
      path.join(codexDir, 'session.jsonl'),
    );
    await storeDepartedFile(
      dbPath,
      path.join(environment.rootDir, 'departed', 'moved.jsonl'),
      liveCodexEvents,
    );
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('freezes history/events-with-departed.jsonl', async () => {
    const output = await captureStdout(() =>
      runEventsReport({ ...sources, history: true, format: 'jsonl' }, { now: fixedNow }),
    );

    expect(output).toContain('golden-departed-session');
    await expectGolden(
      FIXED_GOLDENS.historyEventsWithDeparted,
      normalizePaths(output, environment.rootDir),
    );
  });

  it('freezes history/usage-monthly-with-history.json', async () => {
    const output = await buildUsageReport('monthly', { ...sources, history: true, json: true });

    expect(output).toContain('2025-01');
    await expectGolden(
      FIXED_GOLDENS.historyUsageMonthlyWithHistory,
      normalizePaths(output, environment.rootDir),
    );
  });

  // Without --history a source pointed at a custom directory gets no history.
  it('freezes history/usage-monthly-without-history.json', async () => {
    const output = await buildUsageReport('monthly', { ...sources, json: true });

    expect(output).not.toContain('2025-01');
    await expectGolden(
      FIXED_GOLDENS.historyUsageMonthlyWithoutHistory,
      normalizePaths(output, environment.rootDir),
    );
  });

  it('never reaches the network', () => {
    expect(pricing.fetch).not.toHaveBeenCalled();
  });
});
