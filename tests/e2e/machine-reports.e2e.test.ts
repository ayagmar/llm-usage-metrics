import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import { runMachineExport } from '../../src/cli/run-machine-export.js';
import type { MachineExportLine } from '../../src/machines/machine-export-bundle.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

let rootDir: string;

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

  const outcome = await syncMachine(
    'laptop',
    { ssh: 'me@laptop' },
    {
      spawnSsh: createInProcessRemote({
        configPath: path.join(remoteDir, 'config.toml'),
        eventStorePath: path.join(remoteDir, 'events.db'),
      }).spawnSsh,
    },
  );
  expect(outcome.ok).toBe(true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe('reports with other machines', () => {
  it("count another machine's usage once, leaving out what this machine already counts", async () => {
    const dataset = await buildUsageEventDataset({ timezone: 'UTC' });

    // pi twice from here (the laptop's copy is left out) and codex twice from the laptop.
    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
    expect(dataset.notes).toEqual([
      'Machines: laptop (synced just now); left out 2 event(s) already counted.',
    ]);
  });

  it('count only the machines --machine names', async () => {
    const local = await buildUsageEventDataset({ timezone: 'UTC', machine: 'local' });
    const laptop = await buildUsageEventDataset({ timezone: 'UTC', machine: ['laptop'] });

    expect(sourcesOf(local.filteredEvents)).toEqual(['pi', 'pi']);
    expect(local.notes).toEqual([]);
    expect(sourcesOf(laptop.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
  });

  it('apply the source and date filters to other machines too', async () => {
    const codexOnly = await buildUsageEventDataset({ timezone: 'UTC', source: 'codex' });
    const january = await buildUsageEventDataset({
      timezone: 'UTC',
      since: '2026-01-05',
      until: '2026-01-05',
    });

    expect(sourcesOf(codexOnly.filteredEvents)).toEqual(['codex', 'codex']);
    expect(sourcesOf(january.filteredEvents)).toEqual(['codex']);
  });

  it('keep counting a session once after its file left this machine', async () => {
    await buildUsageEventDataset({ timezone: 'UTC' });
    await rm(path.join(rootDir, 'local', 'pi', 'session.jsonl'));

    const dataset = await buildUsageEventDataset({ timezone: 'UTC' });

    // The pi session now comes from this machine's history; the laptop's copy is left out.
    expect(sourcesOf(dataset.filteredEvents)).toEqual(['codex', 'codex', 'pi', 'pi']);
  });

  it("apply the report's local dates to other machines at timezone edges", async () => {
    // The laptop's codex event is 2026-01-05T08:00Z: Jan 5 at UTC+14, Jan 4 at UTC-12.
    const window = { since: '2026-01-05', until: '2026-01-05', source: 'codex' };
    const east = await buildUsageEventDataset({ ...window, timezone: 'Pacific/Kiritimati' });
    const west = await buildUsageEventDataset({ ...window, timezone: 'Etc/GMT+12' });

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

    const dataset = await buildUsageEventDataset({ timezone: 'UTC' });

    expect(dataset.notes).toEqual([
      'Machines: laptop (synced just now), vps (never synced; run llm-usage sync vps); left out 2 event(s) already counted.',
    ]);
    expect(dataset.warnings).toEqual([
      expect.stringMatching(/^Left out machine desk: its cache cannot be read/),
    ]);
  });

  it('leave other machines out of a run pointed at a custom source directory', async () => {
    const dataset = await buildUsageEventDataset({
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
});
