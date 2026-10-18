import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import { dedupeRepeatedAcrossFiles } from '../../src/dedup/repeated-across-files.js';
import type { SessionEvent } from '../../src/domain/session-event.js';
import type { UsageEvent } from '../../src/domain/usage-event.js';
import {
  createDefaultAdapters,
  getDefaultSourceIds,
  readSources,
} from '../../src/registry/index.js';
import { createReadDiagnostics } from '../../src/sources/parse-diagnostics.js';
import { PiSourceAdapter } from '../../src/sources/pi/index.js';
import {
  createSourceContext,
  type SourceContext,
  type SourceDiagnostic,
} from '../../src/sources/source-context.js';
import { collect } from '../../src/stream/collect.js';
import { readEvents } from '../../src/stream/read-events.js';
import { fixturePath } from '../helpers/fixtures.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const coreFixtures = (...segments: string[]) =>
  fixturePath(import.meta.url, '../fixtures', ...segments);
const eventFixtures = (...segments: string[]) =>
  fixturePath(import.meta.url, '../fixtures-events', ...segments);
const rootFixtures = (...segments: string[]) =>
  fixturePath(import.meta.url, '../../../../tests/fixtures', ...segments);

const FIXTURE_SOURCES = ['pi', 'claude', 'codex', 'qwen'];
const PI_PARENT_FILE = '2026-03-02T09-00-00-000Z_pi-parent-a.jsonl';
const PI_SESSION_FILE = '2026-03-01T10-00-00-000Z_pi-events-1.jsonl';

// The fields every usage event carries, so `read` output and `readEvents` usage records
// compare on what they share.
const USAGE_EVENT_FIELDS = [
  'source',
  'sessionId',
  'timestamp',
  'repoRoot',
  'provider',
  'model',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'totalTokens',
  'costUsd',
  'singleRequest',
] as const satisfies readonly (keyof UsageEvent)[];

function toUsageFields(event: UsageEvent): Partial<UsageEvent> {
  return Object.fromEntries(
    USAGE_EVENT_FIELDS.filter((field) => event[field] !== undefined).map((field) => [
      field,
      event[field],
    ]),
  );
}

function usageOnly(events: readonly SessionEvent[]): UsageEvent[] {
  return events.filter((event) => event.kind === 'usage');
}

let tempRoot: string;
let fixtureHome: string;

async function makeHome(name: string): Promise<string> {
  const home = path.join(tempRoot, name);
  await mkdir(home, { recursive: true });
  return home;
}

function contextFor(homeDir: string, overrides: Partial<SourceContext> = {}): SourceContext {
  return createSourceContext({ homeDir, env: {}, platform: 'linux', ...overrides });
}

// The CLI's composition over core array forms: each file read whole, repeats across
// files counted once per source, then copied sessions counted once.
async function readLikeTheCli(context: SourceContext, ids: readonly string[]) {
  const results: UsageEvent[] = [];
  let repeatsDropped = 0;
  let copiesDropped = 0;

  for (const adapter of createDefaultAdapters({ sourceIds: ids }, context)) {
    const eventsByFile: UsageEvent[][] = [];

    for (const file of await adapter.discoverFiles()) {
      eventsByFile.push(await collect(adapter.read(file)));
    }

    const unrepeated = adapter.capabilities?.eventsRepeatAcrossFiles
      ? dedupeRepeatedAcrossFiles(eventsByFile)
      : eventsByFile.flat();
    const events = adapter.capabilities?.sessionsCopyEvents
      ? dedupeCopiedSessions(unrepeated)
      : unrepeated;

    repeatsDropped += eventsByFile.flat().length - unrepeated.length;
    copiesDropped += unrepeated.length - events.length;
    results.push(...events);
  }

  return { events: results, repeatsDropped, copiesDropped };
}

function claudeRow(sessionId: string, timestamp: string, index: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId,
    cwd: '/work/demo',
    uuid: `${sessionId}-row-${index}`,
    requestId: `req-${index}`,
    message: {
      id: `msg-${index}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 100 + index, output_tokens: 10 },
    },
  });
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(canonicalTmpdir(), 'read-sources-'));
  fixtureHome = await makeHome('fixture-home');

  const piSessions = path.join(fixtureHome, '.pi', 'agent', 'sessions');
  for (const directory of ['fork-counted', 'fork-uncounted', 'session']) {
    await cp(eventFixtures('pi', directory), path.join(piSessions, directory), {
      recursive: true,
    });
  }
  // A second file holding the parent session's entries, as a pi fork copies them.
  await cp(
    eventFixtures('pi', 'fork-counted', PI_PARENT_FILE),
    path.join(piSessions, 'copy', PI_PARENT_FILE),
  );
  await cp(
    rootFixtures('golden', 'claude', 'continued-session', 'cont-project'),
    path.join(fixtureHome, '.claude', 'projects', 'cont-project'),
    { recursive: true },
  );
  await cp(
    eventFixtures('claude', 'two-sessions.jsonl'),
    path.join(fixtureHome, '.claude', 'projects', 'shared', 'two-sessions.jsonl'),
  );
  await cp(coreFixtures('codex'), path.join(fixtureHome, '.codex', 'sessions'), {
    recursive: true,
  });
  await cp(coreFixtures('qwen', 'projects'), path.join(fixtureHome, '.qwen', 'projects'), {
    recursive: true,
  });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readSources', () => {
  it("counts usage as the CLI's composition of the array dedup forms does", async () => {
    const context = contextFor(fixtureHome);
    const expected = await readLikeTheCli(context, FIXTURE_SOURCES);
    const actual = await collect(
      readSources(context, FIXTURE_SOURCES, { dedupe: true, kinds: ['usage'] }),
    );

    // Both dedup steps must drop something, or the comparison proves nothing.
    expect(expected.repeatsDropped).toBeGreaterThan(0);
    expect(expected.copiesDropped).toBeGreaterThan(0);
    expect(new Set(actual.map((event) => event.source))).toEqual(new Set(FIXTURE_SOURCES));
    expect(usageOnly(actual).map(toUsageFields)).toEqual(expected.events.map(toUsageFields));
  });

  it('streams every file as readEvents yields it when dedupe is off', async () => {
    const context = contextFor(fixtureHome);
    const expected: SessionEvent[] = [];

    for (const adapter of createDefaultAdapters({ sourceIds: FIXTURE_SOURCES }, context)) {
      for (const file of await adapter.discoverFiles()) {
        expected.push(...(await collect(readEvents(adapter, file, { text: true }))));
      }
    }

    const actual = await collect(
      readSources(context, FIXTURE_SOURCES, { dedupe: false, text: true }),
    );

    expect(actual.some((event) => event.kind !== 'usage')).toBe(true);
    expect(actual).toEqual(expected);
  });

  it('keeps non-usage kinds through dedup', async () => {
    const context = contextFor(fixtureHome);
    const all = await collect(readSources(context, FIXTURE_SOURCES, { dedupe: false }));
    const deduped = await collect(readSources(context, FIXTURE_SOURCES));

    expect(deduped.filter((event) => event.kind !== 'usage')).toEqual(
      all.filter((event) => event.kind !== 'usage'),
    );
  });

  it('yields sources in registry order whatever order ids lists them in', async () => {
    const context = contextFor(fixtureHome);
    const sources = (await collect(readSources(context, ['qwen', 'codex', 'claude', 'pi']))).map(
      (event) => event.source,
    );

    expect([...new Set(sources)]).toEqual(['pi', 'codex', 'claude', 'qwen']);
  });

  it('applies the window after dedup, so a window does not move which session keeps a copy', async () => {
    // The original session starts earlier, so it keeps the rows the continued session
    // copied. Windowing first would cut that start and, on the tie, hand the copies to the
    // continued session's lower id.
    const home = await makeHome('window-after-dedup');
    const project = path.join(home, '.claude', 'projects', 'demo');
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, 'original.jsonl'),
      [
        claudeRow('zzz-original', '2026-06-01T09:00:00.000Z', 0),
        claudeRow('zzz-original', '2026-06-01T10:00:00.000Z', 1),
        claudeRow('zzz-original', '2026-06-01T10:05:00.000Z', 2),
      ].join('\n') + '\n',
    );
    await writeFile(
      path.join(project, 'continued.jsonl'),
      [
        claudeRow('aaa-continued', '2026-06-01T10:00:00.000Z', 1),
        claudeRow('aaa-continued', '2026-06-01T10:05:00.000Z', 2),
        claudeRow('aaa-continued', '2026-06-01T11:00:00.000Z', 3),
      ].join('\n') + '\n',
    );
    const context = contextFor(home);
    const label = (event: SessionEvent) => `${event.sessionId}@${event.timestamp}`;
    const windowed = await collect(
      readSources(context, ['claude'], {
        kinds: ['usage'],
        since: '2026-06-01T10:00:00.000Z',
        until: new Date('2026-06-01T11:00:00.000Z'),
      }),
    );

    expect(windowed.map(label).sort()).toEqual([
      'zzz-original@2026-06-01T10:00:00.000Z',
      'zzz-original@2026-06-01T10:05:00.000Z',
    ]);
  });

  it('reports nothing and yields nothing for missing default roots', async () => {
    const onDiagnostic = vi.fn<(diagnostic: SourceDiagnostic) => void>();
    const context = contextFor(await makeHome('empty-home'), { onDiagnostic });
    const allIds = getDefaultSourceIds();

    await expect(collect(readSources(context, allIds))).resolves.toEqual([]);
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('reads explicit roots instead of the defaults', async () => {
    const context = contextFor(await makeHome('roots-home'));
    const events = await collect(
      readSources(context, ['qwen'], {
        roots: new Map([['qwen', [coreFixtures('qwen', 'projects')]]]),
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.source === 'qwen')).toBe(true);
  });

  it('reports a missing explicit root as a discovery failure and reads the other sources', async () => {
    const diagnostics: SourceDiagnostic[] = [];
    const missingRoot = path.join(tempRoot, 'missing-pi-root');
    const context = contextFor(fixtureHome, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const events = await collect(
      readSources(context, ['pi', 'qwen'], { roots: new Map([['pi', [missingRoot]]]) }),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: 'pi', level: 'warn' });
    expect(diagnostics[0].path).toBeUndefined();
    expect(diagnostics[0].message).toMatch(/^discovery failed: .*missing-pi-root/u);
    expect(new Set(events.map((event) => event.source))).toEqual(new Set(['qwen']));
  });

  it('rethrows a discovery failure when nothing listens for diagnostics', async () => {
    const context = contextFor(fixtureHome);
    const missingRoot = path.join(tempRoot, 'missing-pi-root');

    await expect(
      collect(readSources(context, ['pi'], { roots: new Map([['pi', [missingRoot]]]) })),
    ).rejects.toThrow(/missing-pi-root/u);
  });

  describe.each([
    { dedupe: true, keepsPartialFile: false },
    { dedupe: false, keepsPartialFile: true },
  ])('a read that throws mid-file, dedupe $dedupe', ({ dedupe, keepsPartialFile }) => {
    const failure = new Error('disk went away');

    // The pi session file fails after its first event; every other file reads normally.
    function failPiSessionFileAfterFirstEvent(): void {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the instance below
      const original = PiSourceAdapter.prototype.readEvents;

      vi.spyOn(PiSourceAdapter.prototype, 'readEvents').mockImplementation(async function* (
        this: PiSourceAdapter,
        filePath,
        options,
      ) {
        for await (const event of original.call(this, filePath, options)) {
          yield event;

          if (path.basename(filePath) === PI_SESSION_FILE) {
            throw failure;
          }
        }
      });
    }

    it(`skips the file${keepsPartialFile ? ', keeping what it yielded,' : ' whole'} and reports it`, async () => {
      const diagnostics: SourceDiagnostic[] = [];
      const context = contextFor(fixtureHome, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      const healthy = await collect(readSources(context, ['pi'], { dedupe }));
      const sessionFileEvents = await collect(
        readEvents(
          createDefaultAdapters({ sourceIds: ['pi'] }, context)[0],
          path.join(fixtureHome, '.pi', 'agent', 'sessions', 'session', PI_SESSION_FILE),
        ),
      );

      failPiSessionFileAfterFirstEvent();
      const events = await collect(readSources(context, ['pi', 'qwen'], { dedupe }));
      const sessionFileKeys = sessionFileEvents.map((event) => JSON.stringify(event));
      const keptKeys = keepsPartialFile ? sessionFileKeys.slice(0, 1) : [];
      const expectedPi = healthy.filter((event) => {
        const key = JSON.stringify(event);
        return !sessionFileKeys.includes(key) || keptKeys.includes(key);
      });

      expect(sessionFileEvents.length).toBeGreaterThan(1);
      expect(expectedPi.length).toBeGreaterThan(keptKeys.length);
      expect(diagnostics).toEqual([
        {
          source: 'pi',
          level: 'warn',
          path: path.join(fixtureHome, '.pi', 'agent', 'sessions', 'session', PI_SESSION_FILE),
          message: 'read failed: disk went away',
        },
      ]);
      expect(events.filter((event) => event.source === 'pi')).toEqual(expectedPi);
      expect(events.some((event) => event.source === 'qwen')).toBe(true);
    });

    it('rethrows the failure when nothing listens for diagnostics', async () => {
      failPiSessionFileAfterFirstEvent();

      await expect(
        collect(readSources(contextFor(fixtureHome), ['pi', 'qwen'], { dedupe })),
      ).rejects.toBe(failure);
    });
  });

  it("hands each source's reads the diagnostics its factory returns", async () => {
    const context = contextFor(fixtureHome);
    const bySource = new Map<string, ReturnType<typeof createReadDiagnostics>>();
    const factory = vi.fn((sourceId: string) => {
      const diagnostics = createReadDiagnostics();
      bySource.set(sourceId, diagnostics);
      return diagnostics;
    });
    const expected = createReadDiagnostics();
    const [qwen] = createDefaultAdapters({ sourceIds: ['qwen'] }, context);

    for (const file of await qwen.discoverFiles()) {
      await collect(qwen.read(file, { diagnostics: expected }));
    }

    await collect(readSources(context, ['pi', 'qwen'], { diagnostics: factory }));

    expect(factory.mock.calls).toEqual([['pi'], ['qwen']]);
    expect(expected.skippedRows).toBeGreaterThan(0);
    expect(bySource.get('qwen')).toEqual(expected);
  });

  it('throws on an unknown source id or an invalid window bound before reading', () => {
    const context = contextFor(fixtureHome);

    expect(() => readSources(context, ['pi', 'nope'])).toThrow(
      /^readSources: unknown source id\(s\) nope; expected one of pi, codex/u,
    );
    expect(() => readSources(context, ['pi'], { until: 'later' })).toThrow(
      'until: invalid date "later"',
    );
  });

  it('throws on an empty roots entry before reading, instead of requiring the default root', () => {
    const context = contextFor(fixtureHome);

    for (const id of ['opencode', 'qwen']) {
      expect(() => readSources(context, [id], { roots: new Map([[id, []]]) })).toThrow(
        `readSources: roots for ${id} is empty; give at least one root, or drop the entry to read its default locations`,
      );
    }
  });

  it('throws on several roots for a single-file source, not for a directory source', () => {
    const context = contextFor(fixtureHome);

    for (const id of ['opencode', 'goose']) {
      expect(() =>
        readSources(context, [id], { roots: new Map([[id, ['/a.db', '/b.db']]]) }),
      ).toThrow(`readSources: ${id} reads one database file, so it takes one root, not 2`);
    }

    for (const id of ['qwen', 'antigravity']) {
      expect(() =>
        readSources(context, [id], { roots: new Map([[id, ['/a', '/b']]]) }),
      ).not.toThrow();
    }
  });

  it('throws on roots for a source that ids does not select, before reading', () => {
    const context = contextFor(fixtureHome);
    const roots = new Map([
      ['qwen', [coreFixtures('qwen', 'projects')]],
      ['codex', [coreFixtures('codex')]],
    ]);

    expect(() => readSources(context, ['pi', 'qwen'], { roots })).toThrow(
      'readSources: roots given for source id(s) codex that ids does not select; add them to ids or drop their roots',
    );
  });
});
