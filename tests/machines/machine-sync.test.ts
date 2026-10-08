import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runMachineAdd,
  runMachineList,
  runMachineRemove,
  runSync,
} from '../../src/cli/run-machine-commands.js';
import {
  getMachineCachePath,
  openMachineCache,
  readMachineCacheStatus,
} from '../../src/machines/machine-cache.js';
import { closeEventStore } from '../../src/persistence/event-store.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { pathExists } from '../../src/utils/fs-helpers.js';
import { appendCodexTurn, createInProcessRemote } from '../helpers/machine-remote.js';

let rootDir: string;
let localConfigPath: string;
let remote: { configPath: string; eventStorePath: string; codexFile: string };
let printed: string[];

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

const print = (line: string) => printed.push(line);

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'machine-sync-'));
  printed = [];

  // The "remote" machine: its own config, logs and ledger.
  const remoteDir = path.join(rootDir, 'remote');
  await cp(path.resolve('tests/fixtures/e2e/codex'), path.join(remoteDir, 'codex'), {
    recursive: true,
  });
  remote = {
    configPath: path.join(remoteDir, 'config.toml'),
    eventStorePath: path.join(remoteDir, 'events.db'),
    codexFile: path.join(remoteDir, 'codex', 'session.jsonl'),
  };
  await writeFile(remote.configPath, 'sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n');

  localConfigPath = path.join(rootDir, 'local', 'config.toml');
  await mkdir(path.dirname(localConfigPath));
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', localConfigPath);
  vi.stubEnv('XDG_DATA_HOME', path.join(rootDir, 'data'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(rootDir, { recursive: true, force: true });
});

describe('machine add, sync, list and remove', () => {
  it('adds a machine after a first sync, keeping the existing config text', async () => {
    await writeFile(localConfigPath, '# my settings\ntimezone = "UTC"\n');
    const { spawnSsh, calls } = createInProcessRemote(remote);

    await runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print, now: () => NOW });

    expect(await readFile(localConfigPath, 'utf8')).toBe(
      '# my settings\ntimezone = "UTC"\n\n[machines.laptop]\nssh = "me@laptop"\n',
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        'BatchMode=yes',
        '--',
        'me@laptop',
        'llm-usage machine export --known - --quiet',
      ]),
    );
    expect(calls[1].indexOf('--')).toBe(calls[1].indexOf('me@laptop') - 1);
    expect(printed).toEqual([
      expect.stringMatching(
        /^✓ laptop: 1 file\(s\) updated, 0 removed; 1 file\(s\), 2 event\(s\) cached/,
      ),
      `Added laptop to ${localConfigPath}. Reports now include its usage; llm-usage sync fetches it again.`,
    ]);
    expect(await readMachineCacheStatus('laptop')).toMatchObject({
      fileCount: 1,
      eventCount: 2,
      state: { syncedAt: NOW, hostname: os.hostname() },
    });
  });

  it('launches llm-usage from the directory only a login shell finds', async () => {
    const { spawnSsh, calls } = createInProcessRemote({
      ...remote,
      loginShellCommand:
        'llm-usage-metrics: asking the login shell\nWelcome!\ncommand=/home/me/.fnm/aliases/default/bin/llm-usage\nnode=/home/me/.fnm/aliases/default/bin/node',
    });

    await runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print });

    const command = 'env PATH=/home/me/.fnm/aliases/default/bin:"$PATH" llm-usage';
    expect(calls[1].at(-1)).toBe(`${command} machine export --known - --quiet`);
    expect(await readFile(localConfigPath, 'utf8')).toBe(
      `[machines.laptop]\nssh = "me@laptop"\ncommand = ${JSON.stringify(command)}\n`,
    );
  });

  it('uses the name as the ssh destination when none is given', async () => {
    const { spawnSsh, calls } = createInProcessRemote(remote);

    await runMachineAdd('laptop', undefined, {}, { spawnSsh, print });

    expect(calls[1]).toContain('laptop');
    expect(await readFile(localConfigPath, 'utf8')).toBe('[machines.laptop]\nssh = "laptop"\n');
  });

  it('syncs only what changed, and lists the result', async () => {
    const { spawnSsh } = createInProcessRemote(remote);
    await runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print });
    printed = [];

    await runSync([], {}, { spawnSsh, print, now: () => NOW });
    await runMachineList({ print, now: () => NOW + 5 * 60_000 });

    expect(printed).toEqual([
      expect.stringMatching(/^✓ laptop: up to date; 1 file\(s\), 2 event\(s\) cached/),
      'laptop  me@laptop  synced 5 min ago, 1 file(s), 2 event(s)',
    ]);
  });

  it('applies changed, removed and fully resent files', async () => {
    const machine = { ssh: 'me@laptop' };
    const sync = (options: { full?: boolean } = {}) =>
      syncMachine('laptop', machine, {
        ...options,
        spawnSsh: createInProcessRemote(remote).spawnSsh,
      });
    await sync();

    // One more turn in the remote session: only that file is sent again.
    await appendCodexTurn(remote.codexFile);
    expect(await sync()).toMatchObject({
      ok: true,
      result: { receivedFileCount: 1, removedFileCount: 0, fileCount: 1, eventCount: 3 },
    });

    expect(await sync({ full: true })).toMatchObject({
      ok: true,
      result: { receivedFileCount: 1, removedFileCount: 0, eventCount: 3 },
    });

    // A source the remote no longer counts leaves the cache.
    await writeFile(remote.configPath, 'sources = ["pi"]\n[sourceDirs]\npi = "pi"\n');
    await mkdir(path.join(path.dirname(remote.configPath), 'pi'));
    expect(await sync()).toMatchObject({
      ok: true,
      result: { receivedFileCount: 0, removedFileCount: 1, fileCount: 0, eventCount: 0 },
    });
  });

  it('rejects a bundle that does not add up, leaving the cache as it was', async () => {
    await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
      },
    );
    const before = await readMachineCacheStatus('laptop');
    const inflateEnd = (bundle: string) =>
      bundle.replace(
        /"eventCount":(\d+)\}/u,
        (_match, count: string) => `"eventCount":${Number(count) + 1}}`,
      );
    const listUnsentRevision = (bundle: string) =>
      bundle.replace(
        /"files":\[\["codex","([^"]+)","[0-9a-f]+"\]\]/u,
        '"files":[["codex","$1","0000"]]',
      );

    for (const rewrite of [inflateEnd, listUnsentRevision]) {
      const outcome = await syncMachine(
        'laptop',
        { ssh: 'me@laptop' },
        {
          spawnSsh: createInProcessRemote({ ...remote, rewrite }).spawnSsh,
        },
      );

      expect(outcome.ok).toBe(false);
      expect((await readMachineCacheStatus('laptop'))?.eventCount).toBe(before?.eventCount);
    }
  });

  it('prints the warnings of a successful export', async () => {
    await runMachineAdd(
      'laptop',
      'me@laptop',
      {},
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
        print,
      },
    );
    printed = [];

    await runSync(
      [],
      {},
      {
        spawnSsh: createInProcessRemote({
          ...remote,
          warning: '⚠ machine export left out 2 event(s)',
        }).spawnSsh,
        print,
      },
    );

    expect(printed).toEqual([
      expect.stringMatching(/^✓ laptop: up to date/),
      '  laptop warned: ⚠ machine export left out 2 event(s)',
    ]);
  });

  it('refuses to add over an invalid entry of the same name before syncing', async () => {
    await writeFile(localConfigPath, '[machines.laptop]\nssh = ""\n');
    const { spawnSsh, calls } = createInProcessRemote(remote);

    await expect(runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print })).rejects.toThrow(
      'already has a machines.laptop entry that is not valid',
    );
    expect(calls).toEqual([]);
  });

  it('keeps the cached usage and records the error when a sync fails', async () => {
    await runMachineAdd(
      'laptop',
      'me@laptop',
      {},
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
        print,
        now: () => NOW,
      },
    );
    const failing = createInProcessRemote({
      ...remote,
      fail: {
        exitCode: 255,
        stderr: 'ssh: connect to host laptop port 22: Connection timed out\n',
      },
    });
    printed = [];

    await runSync([], {}, { spawnSsh: failing.spawnSsh, print, now: () => NOW + 60 * 60_000 });

    expect(process.exitCode).toBe(1);
    expect(printed).toEqual([
      '✗ laptop: ssh failed: ssh: connect to host laptop port 22: Connection timed out (reports keep its usage from 1 h ago)',
    ]);
    expect(await readMachineCacheStatus('laptop')).toMatchObject({
      eventCount: 2,
      state: {
        syncedAt: NOW,
        attemptedAt: NOW + 60 * 60_000,
        lastError: 'ssh failed: ssh: connect to host laptop port 22: Connection timed out',
      },
    });
  });

  it('discards an export that ended early', async () => {
    const outcome = await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      {
        spawnSsh: createInProcessRemote({
          ...remote,
          rewrite: (bundle) => bundle.split('\n').slice(0, -2).join('\n'),
        }).spawnSsh,
      },
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: 'the export from me@laptop is invalid: the export ended early (no end line)',
    });
    expect(await readMachineCacheStatus('laptop')).toMatchObject({ eventCount: 0, fileCount: 0 });
  });

  it('reads a machine status while a sync holds the cache', async () => {
    await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
      },
    );
    const writer = await openMachineCache('laptop');
    writer.database.exec('BEGIN IMMEDIATE');

    try {
      const started = Date.now();
      await expect(readMachineCacheStatus('laptop')).resolves.toMatchObject({ eventCount: 2 });
      // Below the 2 s busy timeout: the read did not wait for the writer.
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      writer.database.exec('ROLLBACK');
      closeEventStore(writer);
    }
  });

  it('reports a cache it cannot open as that machine failing', async () => {
    await mkdir(getMachineCachePath('laptop'), { recursive: true });

    const outcome = await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
      },
    );

    expect(outcome).toMatchObject({ ok: false, state: {} });
    expect(outcome.ok ? '' : outcome.error).toContain(
      `cannot open its cache at ${getMachineCachePath('laptop')}`,
    );
  });

  it('leaves config and cache untouched when the first sync fails', async () => {
    const { spawnSsh } = createInProcessRemote({
      ...remote,
      fail: { exitCode: 255, stderr: 'me@laptop: Permission denied (publickey).' },
    });

    await expect(runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print })).rejects.toThrow(
      'Could not add laptop: ssh could not log in without a prompt: me@laptop: Permission denied (publickey). Set up key login (ssh-copy-id me@laptop) or load your key into ssh-agent.',
    );
    expect(await pathExists(getMachineCachePath('laptop'))).toBe(false);
    expect(await pathExists(localConfigPath)).toBe(false);
  });

  it('removes the machine and its cache', async () => {
    await runMachineAdd(
      'laptop',
      'me@laptop',
      {},
      {
        spawnSsh: createInProcessRemote(remote).spawnSsh,
        print,
      },
    );

    await runMachineRemove('laptop', { print });

    expect(await readFile(localConfigPath, 'utf8')).toBe('');
    expect(await pathExists(getMachineCachePath('laptop'))).toBe(false);
  });

  it('rejects unknown machine names and skips disabled machines', async () => {
    await writeFile(localConfigPath, '[machines.old]\nssh = "old"\nenabled = false\n');

    await expect(runSync(['nope'], {}, { print })).rejects.toThrow(
      'Unknown machine(s): nope (configured: old)',
    );
    await runSync([], {}, { print });

    expect(printed).toEqual(['Every machine is disabled; name one to sync it anyway.']);
  });
});
