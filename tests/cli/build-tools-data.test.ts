import { getEventSessionKey } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { buildToolsData, LIVE_TOOL_CALLS_NOTE } from '../../src/cli/build-tools-data.js';
import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import {
  readLiveSessionEvents,
  type LiveEventKind,
  type ReadLiveSessionEventsOptions,
} from '../../src/cli/read-live-session-events.js';
import type {
  BuildUsageDataDeps,
  ToolsCommandOptions,
} from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  createToolFixtureAdapters,
  type ToolFixtureOptions,
} from '../helpers/tool-call-fixtures.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

function createDeps(fixtureOptions: ToolFixtureOptions = {}): BuildUsageDataDeps {
  return {
    now: () => NOW,
    createAdapters: () => createToolFixtureAdapters(fixtureOptions),
    getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
  };
}

function build(options: ToolsCommandOptions = {}, fixtureOptions: ToolFixtureOptions = {}) {
  return buildToolsData({ timezone: 'UTC', ...options }, createDeps(fixtureOptions));
}

function summarize(rows: readonly { name: string; calls: number }[]): [string, number][] {
  return rows.map((row) => [row.name, row.calls]);
}

describe('buildToolsData', () => {
  useIsolatedEnvironment();

  it('covers the last 7 days by default and counts a copied call once', async () => {
    const result = await build();

    expect(result.defaultWindowSince).toBe('2026-06-15');
    expect(result.data).toMatchObject({ since: '2026-06-15', until: null, rowCount: 9 });
    // Bash: claude-a's 3 plus claude-b's own call; toolu-1 in claude-b is a copy.
    expect(summarize(result.data.rows)).toEqual([
      ['Bash', 4],
      ['exec_command', 3],
      ['Read', 2],
      ['Edit', 1],
      ['Grep', 1],
      ['apply_patch', 1],
      ['bash', 1],
      ['read', 1],
      ['web_search', 1],
    ]);
    expect(result.data.totals).toMatchObject({ calls: 15, errors: 4, unknown: 2, sessions: 4 });
  });

  it('labels projects as projects does and a session without usage as unattributed', async () => {
    const { data } = await build();
    const topProjects = new Map(data.rows.map((row) => [row.name, row.topProject]));

    expect(topProjects.get('Bash')).toBe('a/api');
    expect(topProjects.get('Grep')).toBe('b/api');
    expect(topProjects.get('exec_command')).toBe('tools');
    expect(topProjects.get('bash')).toBe('(unattributed)');
  });

  it('honours --all, --last and --since/--until', async () => {
    const all = await build({ all: true });
    const lastTwo = await build({ last: '2' });
    const dated = await build({ since: '2026-06-01', until: '2026-06-01' });

    expect(all.defaultWindowSince).toBeUndefined();
    expect(all.data.rows[0]).toMatchObject({ name: 'exec_command', calls: 6 });
    expect(lastTwo.data.totals.calls).toBe(8);
    expect(summarize(dated.data.rows)).toEqual([['exec_command', 3]]);
  });

  it('keeps only the sessions of the --repo projects', async () => {
    const { data } = await build({ repo: 'b/api' });

    // claude-a is not read, so the call claude-b copied from it counts.
    expect(summarize(data.rows)).toEqual([
      ['Bash', 2],
      ['Grep', 1],
    ]);
  });

  it('keeps only the --source sources', async () => {
    const { data } = await build({ source: 'pi' });

    expect(summarize(data.rows)).toEqual([
      ['bash', 1],
      ['read', 1],
    ]);
  });

  it('splits rows with --by-source and --by-repo and labels the split projects', async () => {
    const { data } = await build({ bySource: true, byRepo: true });
    const bash = data.rows.filter((row) => row.name === 'Bash');

    expect(bash.map((row) => [row.source, row.project, row.calls])).toEqual([
      ['claude', 'a/api', 3],
      ['claude', 'b/api', 1],
    ]);
  });

  it('limits rows with --top, 20 by default and all with 0', async () => {
    const top = await build({ top: '2' });
    const all = await build({ top: '0' });

    expect(top.data.rows).toHaveLength(2);
    expect(top.data.rowCount).toBe(9);
    expect(top.data.totals.calls).toBe(15);
    expect(top.limitNote).toBe('Showing top 2 of 9 tools by calls. Use --top 0 for all.');
    expect(all.limitNote).toBeUndefined();
    await expect(build({ top: '-1' })).rejects.toThrow('--top must be a non-negative integer');
  });

  it('notes that tool calls come only from files on disk', async () => {
    const { diagnostics } = await build();

    expect(diagnostics.notes).toContain(LIVE_TOOL_CALLS_NOTE);
    expect(diagnostics.pricingOrigin).toBe('none');
  });

  it('leaves out a file whose live read fails and warns', async () => {
    const { data, diagnostics } = await build(
      {},
      { failingFiles: new Set(['/tools-fixture/codex/c.jsonl']) },
    );

    expect(data.rows.map((row) => row.name)).not.toContain('exec_command');
    expect(diagnostics.warnings).toContain('Tool calls left out of 1 file that could not be read');
  });

  it('reads only the files of sources that declare tool calls', async () => {
    const opened: string[] = [];
    await build({}, { onLiveRead: (filePath) => opened.push(filePath) });

    expect(opened.sort()).toEqual([
      '/tools-fixture/claude/a.jsonl',
      '/tools-fixture/claude/b.jsonl',
      '/tools-fixture/codex/c.jsonl',
      '/tools-fixture/codex/old.jsonl',
      '/tools-fixture/pi/d.jsonl',
    ]);
  });
});

describe('readLiveSessionEvents', () => {
  useIsolatedEnvironment();

  async function readFixture<K extends LiveEventKind>(options: ReadLiveSessionEventsOptions<K>) {
    const dataset = await buildUsageEventDataset({ timezone: 'UTC' }, createDeps());
    return readLiveSessionEvents(dataset, options);
  }

  it('limits the read to given sessions or files', async () => {
    const bySession = await readFixture({
      kinds: ['tool_call'],
      sessionKeys: new Set([getEventSessionKey({ source: 'pi', sessionId: 'pi-d' })]),
    });
    const byFile = await readFixture({
      kinds: ['tool_call'],
      filePaths: new Set(['/tools-fixture/claude/b.jsonl']),
    });

    expect(bySession.events.map((event) => event.name)).toEqual(['bash', 'read']);
    expect(byFile.fileCount).toBe(1);
    expect(new Set(byFile.events.map((event) => event.sessionId))).toEqual(new Set(['claude-b']));
  });

  it('reads nothing when --machine leaves this machine out', async () => {
    const dataset = await buildUsageEventDataset({ timezone: 'UTC' }, createDeps());
    const otherMachineOnly = {
      ...dataset,
      normalizedInputs: { ...dataset.normalizedInputs, machineFilter: new Set(['laptop']) },
    };

    expect(await readLiveSessionEvents(otherMachineOnly, { kinds: ['tool_call'] })).toEqual({
      events: [],
      fileCount: 0,
      failedFilePaths: [],
    });
  });

  it('yields only the requested kinds', async () => {
    const { events, fileCount } = await readFixture({ kinds: ['message'] });

    expect(events).toEqual([]);
    expect(fileCount).toBe(0);
  });
});
