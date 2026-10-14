import { mkdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import type {
  BuildUsageDataDeps,
  EventsCommandOptions,
} from '../../src/cli/usage-data-contracts.js';
import type { UsageEvent } from '../../src/domain/usage-event.js';
import { computeEventContentHash } from '../../src/persistence/event-store-codec.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  appendOpenCodeMessages,
  createOpenCodeFixtureDb,
  E2E_OPENCODE_MESSAGES,
} from '../helpers/opencode-fixtures.js';
import {
  ALL_SOURCE_IDS,
  captureStdout,
  createE2eSourceOptions,
  eventsGoldenName,
  expectGolden,
  FIXED_GOLDENS,
  FIXED_NOW,
  fixedNow,
  freezeDate,
  getFixtureSetLabel,
  getFixtureSetOptions,
  listFixtureSets,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

const fixtureSets = await listFixtureSets();

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`events goldens (${WINDOWS_SKIP_REASON})`, () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck();
  let e2eOptions: SourceOptions;

  beforeAll(async () => {
    freezeDate();
    e2eOptions = await createE2eSourceOptions(environment.rootDir);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  async function captureEvents(
    options: EventsCommandOptions,
    deps: BuildUsageDataDeps = {},
  ): Promise<string> {
    const output = await captureStdout(() =>
      runEventsReport(
        { ...options, timezone: 'UTC', pricingOffline: true },
        { now: fixedNow, ...deps },
      ),
    );
    return normalizePaths(output, environment.rootDir);
  }

  function storeDeps(dbPath: string): BuildUsageDataDeps {
    return { getEventStoreRuntimeConfig: () => ({ enabled: true, path: dbPath }) };
  }

  function allSourcesOptions(): EventsCommandOptions {
    return { ...e2eOptions, source: ALL_SOURCE_IDS.join(',') };
  }

  for (const set of fixtureSets) {
    it(`freezes the ${getFixtureSetLabel(set)} events`, async () => {
      const output = await captureEvents({
        ...getFixtureSetOptions(set, e2eOptions, environment.rootDir),
        source: set.source,
        format: 'jsonl',
      });

      expect(output.length).toBeGreaterThan(0);
      await expectGolden(eventsGoldenName(set), output);
    });
  }

  it('freezes every source at once as jsonl, csv and content hashes', async () => {
    const jsonl = await captureEvents({ ...allSourcesOptions(), format: 'jsonl' });
    const events = jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as UsageEvent);

    expect(new Set(events.map((event) => event.source))).toEqual(new Set(ALL_SOURCE_IDS));
    // Summary windows end at FIXED_NOW; a later fixture event falls outside them. The dsh
    // e2e fixture is dated 2026-09-11 and is the one known exception.
    const sourcesAfterNow = new Set(
      events
        .filter((event) => Date.parse(event.timestamp) >= FIXED_NOW.getTime())
        .map((event) => event.source),
    );
    expect([...sourcesAfterNow]).toEqual(['dsh']);

    await expectGolden(FIXED_GOLDENS.eventsAllSourcesJsonl, jsonl);
    await expectGolden(
      FIXED_GOLDENS.eventsAllSourcesCsv,
      await captureEvents({ ...allSourcesOptions(), format: 'csv' }),
    );
    await expectGolden(
      FIXED_GOLDENS.eventsAllSourcesHashes,
      `${events.map((event) => computeEventContentHash(event)).join('\n')}\n`,
    );
  });

  it('freezes OpenCode events before and after rows are appended to a stored database', async () => {
    const dir = path.join(environment.rootDir, 'opencode-appended');
    const dbPath = path.join(dir, 'opencode.db');
    const deps = storeDeps(path.join(dir, 'events.db'));
    await mkdir(dir);
    createOpenCodeFixtureDb(dbPath, E2E_OPENCODE_MESSAGES);
    const options: EventsCommandOptions = { opencodeDb: dbPath, source: 'opencode' };

    await expectGolden(
      FIXED_GOLDENS.eventsOpencodeAppendedBefore,
      await captureEvents(options, deps),
    );

    appendOpenCodeMessages(dbPath, [
      {
        id: 'opencode-e2e-message-3',
        sessionId: 'opencode-e2e-session',
        timeCreated: Date.parse('2026-06-15T12:10:00.000Z'),
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1-opencode',
          tokens: { input: 50, output: 25, reasoning: 0, cache: { read: 0, write: 0 }, total: 75 },
        }),
      },
      {
        id: 'opencode-e2e-message-4',
        sessionId: 'opencode-e2e-session',
        timeCreated: Date.parse('2026-06-15T12:15:00.000Z'),
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1-opencode',
          tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 4, write: 0 }, total: 34 },
        }),
      },
    ]);
    const { mtime } = await stat(dbPath);
    const later = new Date(mtime.getTime() + 60_000);
    await utimes(dbPath, later, later);

    await expectGolden(
      FIXED_GOLDENS.eventsOpencodeAppendedAfter,
      await captureEvents(options, deps),
    );
  });

  it('prints the same events from a warm event store as from a fresh parse', async () => {
    const dir = path.join(environment.rootDir, 'store-warm');
    const deps = storeDeps(path.join(dir, 'events.db'));
    await mkdir(dir);
    const options: EventsCommandOptions = { ...allSourcesOptions(), format: 'jsonl' };

    await captureEvents(options, deps);
    const warm = await captureEvents(options, deps);

    expect(warm).toBe(await captureEvents(options));
    await expectGolden(FIXED_GOLDENS.eventsStoreWarm, warm);
  });

  it('never reaches the network', () => {
    expect(pricing.fetch).not.toHaveBeenCalled();
  });
});
