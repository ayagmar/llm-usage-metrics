import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildSessionData } from '../../src/cli/build-session-data.js';
import { addSessionDetails } from '../../src/cli/build-session-details.js';
import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  createToolFixtureAdapters,
  type ToolFixtureOptions,
} from '../helpers/tool-call-fixtures.js';
import type { SessionRow } from '../../src/session/session-row.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    read: readFrom(async (filePath) => eventsByFile[filePath] ?? []),
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
              read: readFrom(async () => []),
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
          adapters: [{ id: 'pi', discoverFiles, read: readFrom(async () => []) }],
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
          adapters: [{ id: 'pi', discoverFiles, read: readFrom(async () => []) }],
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

  it('labels projects from every session, not only the ones --top shows', async () => {
    const result = await buildSessionData(
      { top: '1', timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({
                sessionId: 'shown',
                outputTokens: 1_000_000,
                totalTokens: 1_000_010,
                repoRoot: '/home/user/work/app',
              }),
              createBaseEvent({ sessionId: 'hidden', repoRoot: '/home/user/oss/app' }),
            ],
          }),
        ],
      }),
    );

    expect(sessionRowsOf(result).map((row) => row.sessionId)).toEqual(['shown']);
    expect(result.projectLabels.get('/home/user/work/app')).toBe('work/app');
  });

  it('groups repo roots that differ only by a trailing separator into one row', async () => {
    const result = await buildSessionData(
      { byRepo: true, timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ sessionId: 'a', repoRoot: '/home/user/app' }),
              createBaseEvent({ sessionId: 'b', repoRoot: '/home/user/app/' }),
            ],
          }),
        ],
      }),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ repoRoot: '/home/user/app', sessionCount: 2 });
    expect(result.projectLabels.get('/home/user/app')).toBe('app');
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

describe('buildSessionData --timeline', () => {
  it('lists up to 10 matching ids with source and date when --id names several sessions', async () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      createBaseEvent({
        sessionId: `shared-${String(index).padStart(2, '0')}`,
        timestamp: `2026-03-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );

    const error = await buildSessionData(
      { id: ['shared'], timeline: true, timezone: 'UTC' },
      runtimeDeps({ adapters: [createAdapter('pi', { '/tmp/pi.jsonl': events })] }),
    ).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    const lines = error instanceof Error ? error.message.split('\n') : [];

    expect(lines[0]).toBe('--timeline needs exactly one session, but --id shared matches 12:');
    // Equal cost, so the newest session comes first.
    expect(lines.slice(1, 3)).toEqual([
      '  pi  shared-11  2026-03-12',
      '  pi  shared-10  2026-03-11',
    ]);
    expect(lines.filter((line) => line.includes('shared-'))).toHaveLength(10);
    expect(lines.slice(-2)).toEqual([
      '  and 2 more',
      'Pass more of the session id to --id, or narrow with --source.',
    ]);
  });

  it('takes the session whose id equals --id when the id is also part of a longer one', async () => {
    const result = await buildSessionData(
      { id: ['abc'], timeline: true, timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ sessionId: 'abc' }),
              createBaseEvent({ sessionId: 'abc-resumed' }),
            ],
          }),
        ],
      }),
    );

    expect(result.grouping === 'timeline' && result.session.sessionId).toBe('abc');
  });

  it('refuses an id two sources share exactly, pointing at --source', async () => {
    await expect(
      buildSessionData(
        { id: ['abc'], timeline: true, timezone: 'UTC' },
        runtimeDeps({
          adapters: [
            createAdapter('pi', { '/tmp/pi.jsonl': [createBaseEvent({ sessionId: 'abc' })] }),
            createAdapter('codex', {
              '/tmp/codex.jsonl': [createBaseEvent({ source: 'codex', sessionId: 'abc' })],
            }),
          ],
        }),
      ),
    ).rejects.toThrow('Pass more of the session id to --id, or narrow with --source.');
  });

  it('names a way forward when --id matches no session', async () => {
    await expect(
      buildSessionData(
        { id: ['missing'], timeline: true, timezone: 'UTC' },
        runtimeDeps({
          adapters: [createAdapter('pi', { '/tmp/pi.jsonl': [createBaseEvent()] })],
        }),
      ),
    ).rejects.toThrow(
      '--timeline found no session matching --id missing. Run `llm-usage session` to list session ids, or widen --since/--until.',
    );
  });

  it.each([
    [{}, '--timeline needs --id <session-id> naming one session'],
    [
      { id: ['session-1'], top: '5' },
      '--timeline shows every request; it cannot be combined with --top',
    ],
  ])('rejects %o before parsing sources', async (options, message) => {
    const discoverFiles = vi.fn(async () => ['/tmp/pi.jsonl']);

    await expect(
      buildSessionData(
        { ...options, timeline: true, timezone: 'UTC' },
        runtimeDeps({ adapters: [{ id: 'pi', discoverFiles, read: readFrom(async () => []) }] }),
      ),
    ).rejects.toThrow(message);
    expect(discoverFiles).not.toHaveBeenCalled();
  });

  it("reads tool calls live from the session's source only, every file of it", async () => {
    const liveReads: string[] = [];
    const liveAdapter = (
      id: SourceAdapter['id'],
      usageByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
    ): SourceAdapter => ({
      ...createAdapter(id, usageByFile),
      capabilities: { kinds: ['usage', 'tool_call', 'message'] },
      async *readEvents(filePath) {
        liveReads.push(filePath);
        yield* [];
      },
    });

    await buildSessionData(
      { id: ['session-1'], timeline: true, timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          liveAdapter('pi', {
            '/tmp/pi-session-1.jsonl': [createBaseEvent()],
            '/tmp/pi-other.jsonl': [createBaseEvent({ sessionId: 'other' })],
          }),
          liveAdapter('codex', {
            '/tmp/codex-other.jsonl': [createBaseEvent({ source: 'codex', sessionId: 'other' })],
          }),
        ],
      }),
    );

    // The other pi files may hold the calls this session copied from its parent.
    expect(liveReads.sort()).toEqual(['/tmp/pi-other.jsonl', '/tmp/pi-session-1.jsonl']);
  });

  it("returns only the matched session's priced requests, in time order", async () => {
    const result = await buildSessionData(
      { id: ['session-1'], timeline: true, timezone: 'UTC' },
      runtimeDeps({
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ timestamp: '2026-03-05T10:05:00.000Z' }),
              createBaseEvent({ sessionId: 'other', timestamp: '2026-03-05T10:02:00.000Z' }),
              createBaseEvent({ timestamp: '2026-03-05T10:00:00.000Z' }),
            ],
          }),
        ],
      }),
    );

    if (result.grouping !== 'timeline') {
      throw new Error(`expected timeline grouping, got ${result.grouping}`);
    }

    expect(result.session.sessionId).toBe('session-1');
    expect(result.diagnostics.notes).toContain(
      'Tool calls and turns are read from session files on disk (claude, codex, pi): with the event store off, files that no longer exist are not counted.',
    );
    expect(result.rows.map((row) => row.timestamp)).toEqual([
      '2026-03-05T10:00:00.000Z',
      '2026-03-05T10:05:00.000Z',
    ]);
    const [first, second] = result.rows;
    expect(first.kind === 'usage' && second.kind === 'usage').toBe(true);
    if (first.kind === 'usage' && second.kind === 'usage') {
      expect(first.costUsd).toBeGreaterThan(0);
      expect(second.runningCostUsd).toBeCloseTo((first.costUsd ?? 0) + (second.costUsd ?? 0), 10);
    }
  });
});

describe('buildSessionData --json details', () => {
  const environment = useIsolatedEnvironment();
  const now = () => new Date('2026-06-21T12:00:00.000Z');

  function toolFixtureDeps(fixtureOptions: ToolFixtureOptions = {}) {
    return {
      ...runtimeDeps({ adapters: createToolFixtureAdapters(fixtureOptions) }),
      now,
    };
  }

  function detailsBySession(rows: readonly SessionRow[]) {
    return Object.fromEntries(
      rows.map((row) => [row.sessionId, { toolCalls: row.toolCalls, toolErrors: row.toolErrors }]),
    );
  }

  it('counts each session its tool calls as tools does, leaving them out for usage-only sources', async () => {
    const result = await buildSessionData({ json: true, timezone: 'UTC' }, toolFixtureDeps());
    const rows = sessionRowsOf(result);

    // claude-b's toolu-1 is a copy of claude-a's call, so it stays claude-a's.
    expect(detailsBySession(rows)).toEqual({
      'claude-a': { toolCalls: 6, toolErrors: 1 },
      'claude-b': { toolCalls: 2, toolErrors: 1 },
      'codex-c': { toolCalls: 5, toolErrors: 1 },
      'codex-old': { toolCalls: 3, toolErrors: 0 },
      'gemini-e': { toolCalls: undefined, toolErrors: undefined },
    });
    expect(rows.find((row) => row.source === 'gemini')).not.toHaveProperty('toolCalls');
    expect(result.diagnostics.notes).toContain(
      'Tool calls are read from session files on disk (claude, codex, pi): with the event store off, files that no longer exist are not counted.',
    );
  });

  it('keeps a copied call with its parent when --id shows only the copy', async () => {
    const result = await buildSessionData(
      { json: true, id: ['claude-b'], timezone: 'UTC' },
      toolFixtureDeps(),
    );

    expect(detailsBySession(sessionRowsOf(result))).toEqual({
      'claude-b': { toolCalls: 2, toolErrors: 1 },
    });
  });

  it('reads no tool calls for terminal or Markdown output', async () => {
    const liveReads: string[] = [];
    const result = await buildSessionData(
      { timezone: 'UTC' },
      toolFixtureDeps({ onLiveRead: (filePath) => liveReads.push(filePath) }),
    );

    expect(liveReads).toEqual([]);
    expect(sessionRowsOf(result).some((row) => 'toolCalls' in row)).toBe(false);
  });

  it('warns and leaves out the calls of a file whose live read fails', async () => {
    const result = await buildSessionData(
      { json: true, timezone: 'UTC' },
      toolFixtureDeps({ failingFiles: new Set(['/tools-fixture/codex/c.jsonl']) }),
    );

    expect(detailsBySession(sessionRowsOf(result))['codex-c']).toEqual({
      toolCalls: 0,
      toolErrors: 0,
    });
    expect(result.diagnostics.warnings).toContain(
      'Tool calls left out of 1 file that could not be read',
    );
  });

  it('lists the stored files holding each session, and none with the event store off', async () => {
    const sessionsDir = path.join(environment.rootDir, 'claude-sessions');
    const mainFile = path.join(sessionsDir, 'a.jsonl');
    const subagentFile = path.join(sessionsDir, 'a', 'subagents', 'agent-1.jsonl');
    const otherFile = path.join(sessionsDir, 'b.jsonl');
    const eventsByFile = {
      [subagentFile]: [createBaseEvent({ source: 'claude', sessionId: 'a' })],
      [mainFile]: [createBaseEvent({ source: 'claude', sessionId: 'a' })],
      [otherFile]: [createBaseEvent({ source: 'claude', sessionId: 'b' })],
    };

    for (const filePath of Object.keys(eventsByFile)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '{}\n');
    }

    const deps = runtimeDeps({ adapters: [createAdapter('claude', eventsByFile)] });
    const storeOn = await buildSessionData(
      { json: true, timezone: 'UTC' },
      {
        ...deps,
        getEventStoreRuntimeConfig: () => ({
          enabled: true as const,
          path: path.join(environment.rootDir, 'events.db'),
        }),
      },
    );
    const storeOff = await buildSessionData({ json: true, timezone: 'UTC' }, deps);
    const filePathsOf = (result: Awaited<ReturnType<typeof buildSessionData>>) =>
      Object.fromEntries(sessionRowsOf(result).map((row) => [row.sessionId, row.filePaths]));

    expect(filePathsOf(storeOn)).toEqual({
      a: [mainFile, subagentFile].sort(),
      b: [otherFile],
    });
    expect(filePathsOf(storeOff)).toEqual({ a: undefined, b: undefined });

    // The store cannot be read after the dataset was built: the report still prints.
    const dataset = await buildUsageEventDataset(
      { timezone: 'UTC' },
      {
        ...deps,
        getEventStoreRuntimeConfig: () => ({
          enabled: true as const,
          path: path.join(environment.rootDir, 'events.db'),
        }),
      },
    );
    const details = await addSessionDetails(
      { ...dataset, ledger: dataset.ledger && { ...dataset.ledger, path: environment.rootDir } },
      sessionRowsOf(storeOff),
      [],
      new Set(),
    );

    expect(details.rows.some((row) => 'filePaths' in row)).toBe(false);
    expect(details.warnings).toHaveLength(1);
    expect(details.warnings[0]).toMatch(
      /^Session files left out: the event store could not be read: /,
    );
  });
});
