import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { buildDoctorResults } from '../../src/cli/run-doctor-report.js';
import { schemaDocuments } from '../../src/cli/report-schema-registry.js';
import { renderReportJson } from '../../src/render/report-json.js';
import { runMachineExport } from '../../src/cli/run-machine-export.js';
import { buildStatusline } from '../../src/cli/run-statusline.js';
import type { MachineExportLine } from '../../src/machines/machine-export-bundle.js';
import { readMachineCacheStatus } from '../../src/machines/machine-cache.js';
import { refreshDueMachines } from '../../src/machines/refresh-machines.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { formatRefreshFailure } from '../../src/render/render-machines.js';
import { appendCodexTurn, createInProcessRemote } from '../helpers/machine-remote.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

let rootDir: string;
let remote: { configPath: string; eventStorePath: string };

/** Reports here never reach real ssh: a due machine "syncs" from the in-process remote. */
function buildDataset(
  options: Parameters<typeof buildUsageEventDataset>[0],
  deps: Parameters<typeof buildUsageEventDataset>[1] = {},
) {
  return buildUsageEventDataset(options, {
    spawnSsh: createInProcessRemote(remote).spawnSsh,
    ...deps,
  });
}

function sourcesOf(events: readonly { source: string }[]): string[] {
  return events.map((event) => event.source).sort();
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'machine-reports-'));
  const remoteDir = path.join(rootDir, 'remote');
  const localDir = path.join(rootDir, 'local');

  // The laptop has the same pi session as this machine (a copied home) plus codex usage.
  for (const source of ['pi', 'codex']) {
    await cp(path.resolve('tests/fixtures/e2e', source), path.join(remoteDir, source), {
      recursive: true,
    });
  }
  await writeFile(
    path.join(remoteDir, 'config.toml'),
    'sources = ["pi", "codex"]\n[sourceDirs]\npi = "pi"\ncodex = "codex"\n',
  );
  await cp(path.resolve('tests/fixtures/e2e/pi'), path.join(localDir, 'pi'), { recursive: true });
  await mkdir(path.join(localDir, 'codex'));
  await writeFile(
    path.join(localDir, 'config.toml'),
    [
      'sources = ["pi", "codex"]',
      '[sourceDirs]',
      'pi = "pi"',
      'codex = "codex"',
      '[machines.laptop]',
      'ssh = "me@laptop"',
      '',
    ].join('\n'),
  );

  vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(localDir, 'config.toml'));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(localDir, 'events.db'));
  vi.stubEnv('XDG_DATA_HOME', path.join(localDir, 'data'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  remote = {
    configPath: path.join(remoteDir, 'config.toml'),
    eventStorePath: path.join(remoteDir, 'events.db'),
  };
  const outcome = await syncMachine(
    'laptop',
    { ssh: 'me@laptop' },
    {
      spawnSsh: createInProcessRemote(remote).spawnSsh,
    },
  );
  expect(outcome.ok).toBe(true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

const ELEVEN_MINUTES = 11 * 60_000;

function later(): Date {
  return new Date(Date.now() + ELEVEN_MINUTES);
}

function exportCalls(calls: string[][]): number {
  return calls.filter((args) => args.at(-1)?.includes('machine export')).length;
}

describe('reports refreshing other machines', () => {
  it('sync a machine whose cache is due, and count its new usage', async () => {
    await appendCodexTurn(path.join(rootDir, 'remote', 'codex', 'session.jsonl'));
    const fresh = createInProcessRemote(remote);
    const due = createInProcessRemote(remote);

    const before = await buildDataset({ timezone: 'UTC' }, { spawnSsh: fresh.spawnSsh });
    const after = await buildDataset({ timezone: 'UTC' }, { spawnSsh: due.spawnSsh, now: later });

    expect(exportCalls(fresh.calls)).toBe(0);
    expect(sourcesOf(before.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
    expect(exportCalls(due.calls)).toBe(1);
    expect(sourcesOf(after.filteredEvents)).toEqual(['codex', 'codex', 'codex', 'pi', 'pi']);
  });

  it('never sync from a status line', async () => {
    const { spawnSsh, calls } = createInProcessRemote(remote);

    const line = await buildStatusline({ timezone: 'UTC' }, { spawnSsh, now: later });

    expect(calls).toEqual([]);
    expect(line).toContain('this month');
  });

  it('wait an interval after a failed sync before trying again', async () => {
    const unreachable = createInProcessRemote({
      ...remote,
      fail: { exitCode: 255, stderr: 'ssh: connect to host laptop port 22: No route to host' },
    });
    const reachable = createInProcessRemote(remote);

    await buildDataset({ timezone: 'UTC' }, { spawnSsh: unreachable.spawnSsh, now: later });
    await buildDataset(
      { timezone: 'UTC' },
      { spawnSsh: reachable.spawnSsh, now: () => new Date(Date.now() + ELEVEN_MINUTES + 60_000) },
    );

    expect(exportCalls(unreachable.calls)).toBe(1);
    expect(exportCalls(reachable.calls)).toBe(0);
  });

  it('give up on a machine that takes too long, and say how to wait for it', async () => {
    const hanging = createInProcessRemote({ ...remote, hang: true });

    const [outcome] = await refreshDueMachines(
      [{ name: 'laptop', machine: { ssh: 'me@laptop' } }],
      {
        spawnSsh: hanging.spawnSsh,
        now: () => Date.now() + ELEVEN_MINUTES,
        timeoutMs: 20,
      },
    );

    expect(hanging.killed).toHaveLength(1);
    expect(formatRefreshFailure(outcome, Date.now() + ELEVEN_MINUTES)?.text).toMatch(
      /^Could not sync laptop \(no complete export within 0s \(timed out\)\); using its usage from 11 min ago\. Run llm-usage sync laptop to wait for it\.$/,
    );
  });

  it('stop the sync when the report fails', async () => {
    const hanging = createInProcessRemote({ ...remote, hang: true });

    // An explicitly requested source that fails to parse ends the report.
    await expect(
      buildDataset(
        { timezone: 'UTC', codexDir: path.join(rootDir, 'missing'), machine: ['local', 'laptop'] },
        { spawnSsh: hanging.spawnSsh, now: later },
      ),
    ).rejects.toThrow('codex');
    // Whether the report fails before or after ssh starts, no export keeps running.
    await vi.waitFor(async () => {
      expect(hanging.killed).toHaveLength(exportCalls(hanging.calls));
      // Stopped on purpose: not recorded as a failed sync.
      expect((await readMachineCacheStatus('laptop'))?.state.lastError).toBeUndefined();
    });
  });

  it('read a disabled machine without syncing it', async () => {
    const configPath = path.join(rootDir, 'local', 'config.toml');
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}enabled = false\n`);
    const { spawnSsh, calls } = createInProcessRemote(remote);

    const dataset = await buildDataset({ timezone: 'UTC' }, { spawnSsh, now: later });

    expect(calls).toEqual([]);
    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
  });

  it('skip the sync with --no-sync', async () => {
    const { spawnSsh, calls } = createInProcessRemote(remote);

    await buildDataset({ timezone: 'UTC', sync: false }, { spawnSsh, now: later });

    expect(calls).toEqual([]);
  });

  it('sync a due machine once when reports run together', async () => {
    const { spawnSsh, calls } = createInProcessRemote(remote);

    await Promise.all([
      buildDataset({ timezone: 'UTC' }, { spawnSsh, now: later }),
      buildDataset({ timezone: 'UTC' }, { spawnSsh, now: later }),
    ]);

    expect(exportCalls(calls)).toBe(1);
  });

  it('use the cached usage, with a note, when the machine cannot be reached', async () => {
    const { spawnSsh } = createInProcessRemote({
      ...remote,
      fail: { exitCode: 255, stderr: 'ssh: connect to host laptop port 22: No route to host' },
    });

    const dataset = await buildDataset({ timezone: 'UTC' }, { spawnSsh, now: later });

    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
    expect(dataset.notes[0]).toBe(
      'Could not sync laptop (ssh failed: ssh: connect to host laptop port 22: No route to host); using its usage from 11 min ago.',
    );
    expect(dataset.warnings).toEqual([]);
  });
});

describe('reports with other machines', () => {
  it("count another machine's usage once, leaving out what this machine already counts", async () => {
    const dataset = await buildDataset({ timezone: 'UTC' });

    // pi twice from here (the laptop's copy is left out) and codex twice from the laptop.
    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
    expect(dataset.notes).toEqual([
      'Machines: laptop (synced just now); left out 2 event(s) already counted.',
    ]);
  });

  it('count only the machines --machine names', async () => {
    const local = await buildDataset({ timezone: 'UTC', machine: 'local' });
    const laptop = await buildDataset({ timezone: 'UTC', machine: ['laptop'] });

    expect(sourcesOf(local.filteredEvents)).toEqual(['pi', 'pi']);
    expect(local.notes).toEqual([]);
    expect(sourcesOf(laptop.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
  });

  it('apply the source and date filters to other machines too', async () => {
    const codexOnly = await buildDataset({ timezone: 'UTC', source: 'codex' });
    const january = await buildDataset({
      timezone: 'UTC',
      since: '2026-01-05',
      until: '2026-01-05',
    });

    expect(sourcesOf(codexOnly.filteredEvents)).toEqual(['codex', 'codex']);
    expect(sourcesOf(january.filteredEvents)).toEqual(['codex']);
  });

  it('keep counting a session once after its file left this machine', async () => {
    await buildDataset({ timezone: 'UTC' });
    await rm(path.join(rootDir, 'local', 'pi', 'session.jsonl'));

    const dataset = await buildDataset({ timezone: 'UTC' });

    // The pi session now comes from this machine's history; the laptop's copy is left out.
    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
  });

  it("apply the report's local dates to other machines at timezone edges", async () => {
    // The laptop's codex event is 2026-01-05T08:00Z: Jan 5 at UTC+14, Jan 4 at UTC-12.
    const window = { since: '2026-01-05', until: '2026-01-05', source: 'codex' };
    const east = await buildDataset({ ...window, timezone: 'Pacific/Kiritimati' });
    const west = await buildDataset({ ...window, timezone: 'Etc/GMT+12' });

    expect(sourcesOf(east.filteredEvents)).toEqual(['codex']);
    expect(sourcesOf(west.filteredEvents)).toEqual([]);
  });

  it('say which machines were never synced and which caches cannot be read', async () => {
    const configPath = path.join(rootDir, 'local', 'config.toml');
    await writeFile(
      configPath,
      `${await readFile(configPath, 'utf8')}[machines.vps]\nssh = "vps"\n[machines.desk]\nssh = "desk"\n`,
    );
    await writeFile(
      path.join(rootDir, 'local', 'data', 'llm-usage-metrics', 'machines', 'desk.db'),
      'not sqlite',
    );

    const unreachable = createInProcessRemote({
      ...remote,
      fail: { exitCode: 255, stderr: 'ssh: connect to host vps port 22: No route to host' },
    });
    const dataset = await buildDataset({ timezone: 'UTC' }, { spawnSsh: unreachable.spawnSsh });

    expect(dataset.notes).toEqual([
      'Machines: laptop (synced just now), vps (never synced; run llm-usage sync vps); left out 2 event(s) already counted.',
    ]);
    expect(dataset.warnings).toEqual([
      'Could not sync vps (ssh failed: ssh: connect to host vps port 22: No route to host); it has no usage cached yet.',
      expect.stringMatching(/^Left out machine desk: its cache cannot be read/),
    ]);
  });

  it('leave other machines out of a run pointed at a custom source directory', async () => {
    const dataset = await buildDataset({
      timezone: 'UTC',
      piDir: path.join(rootDir, 'local', 'pi'),
    });

    expect(sourcesOf(dataset.filteredEvents)).toEqual(['pi', 'pi']);
  });

  it("never re-export another machine's usage", async () => {
    vi.mocked(console.error).mockClear();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    await runMachineExport({}, { stdout });

    const lines = Buffer.concat(chunks)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as MachineExportLine);
    expect(lines.at(-1)).toMatchObject({ type: 'end', eventCount: 2 });
    // Counting the laptop's events would also report them as missing from the ledger.
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain('left out');
  });

  it('show each machine in doctor, from its cache', async () => {
    await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      {
        spawnSsh: createInProcessRemote({
          ...remote,
          fail: { exitCode: 255, stderr: 'ssh: connect to host laptop port 22: No route to host' },
        }).spawnSsh,
        now: () => Date.now() + 60_000,
      },
    );

    const results = await buildDoctorResults({});

    const machineRows = results.filter((result) => result.format === 'ssh');

    expect(machineRows).toMatchObject([
      { id: 'machine:laptop', format: 'ssh', status: 'error', itemsFound: 4 },
    ]);
    expect(machineRows[0].error).toMatch(
      /^me@laptop: synced just now, 2 file\(s\), 4 event\(s\); last attempt failed just now: ssh failed/,
    );
  });

  it('split rows by machine with --by-machine, in JSON the schema accepts', async () => {
    const usage = await buildUsageData(
      'monthly',
      { timezone: 'UTC', byMachine: true, pricingOffline: true },
      { spawnSsh: createInProcessRemote(remote).spawnSsh },
    );
    const sourceRows = usage.rows.filter((row) => row.rowType === 'period_source');

    expect(sourceRows.map((row) => [row.periodKey, row.source, row.machine])).toEqual([
      ['2026-01', 'pi', 'local'],
      ['2026-01', 'codex', 'laptop'],
      ['2026-02', 'pi', 'local'],
      ['2026-02', 'codex', 'laptop'],
    ]);
    const validate = new Ajv2020({ allErrors: true }).compile(schemaDocuments.usage as object);
    expect(
      validate(JSON.parse(renderReportJson('usage', usage.rows))),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('name the machine of each event from another machine', async () => {
    const dataset = await buildDataset({ timezone: 'UTC' });

    expect(dataset.filteredEvents.map((event) => [event.source, event.machine]).sort()).toEqual([
      ['codex', 'laptop'],
      ['codex', 'laptop'],
      ['pi', undefined],
      ['pi', undefined],
    ]);
  });
});
