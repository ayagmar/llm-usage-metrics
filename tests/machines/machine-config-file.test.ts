import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addMachineToConfigFile,
  hasMachineEntry,
  removeMachineFromConfigFile,
} from '../../src/machines/machine-config-file.js';

let rootDir: string;
let configPath: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'machine-config-'));
  configPath = path.join(rootDir, 'llm-usage-metrics', 'config.toml');
});

async function writeConfig(content: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, content);
}

async function temporaryFiles(): Promise<string[]> {
  return (await readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp'));
}

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('addMachineToConfigFile', () => {
  it('creates the config file when there is none', async () => {
    await addMachineToConfigFile(configPath, 'laptop', { ssh: 'me@laptop' });

    expect(await readFile(configPath, 'utf8')).toBe('[machines.laptop]\nssh = "me@laptop"\n');
  });

  it('appends after the existing text, with the command when one is given', async () => {
    await writeConfig('[machines.a]\nssh = "a"\n# trailing comment');

    await addMachineToConfigFile(configPath, 'vps', { ssh: 'vps', command: '/opt/llm "usage"' });

    expect(await readFile(configPath, 'utf8')).toBe(
      [
        '[machines.a]',
        'ssh = "a"',
        '# trailing comment',
        '',
        '[machines.vps]',
        'ssh = "vps"',
        'command = "/opt/llm \\"usage\\""',
        '',
      ].join('\n'),
    );
  });

  it('refuses, without writing, when the appended table would not read back', async () => {
    const original = 'machines = { a = { ssh = "a" } }\n';
    await writeConfig(original);

    await expect(addMachineToConfigFile(configPath, 'b', { ssh: 'b' })).rejects.toThrow(
      'add these lines to it by hand:\n[machines.b]\nssh = "b"\n',
    );
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await temporaryFiles()).toEqual([]);
  });

  it('keeps Windows line endings', async () => {
    await writeConfig('timezone = "UTC"\r\n');

    await addMachineToConfigFile(configPath, 'vps', { ssh: 'vps' });

    expect(await readFile(configPath, 'utf8')).toBe(
      'timezone = "UTC"\r\n\r\n[machines.vps]\r\nssh = "vps"\r\n',
    );
  });

  // Creating a symlink needs extra privileges on Windows.
  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked config to its target',
    async () => {
      const target = path.join(rootDir, 'dotfiles', 'config.toml');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'timezone = "UTC"\n');
      await mkdir(path.dirname(configPath), { recursive: true });
      await symlink(target, configPath);

      await addMachineToConfigFile(configPath, 'vps', { ssh: 'vps' });

      expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(
        'timezone = "UTC"\n\n[machines.vps]\nssh = "vps"\n',
      );
    },
  );
});

describe('hasMachineEntry', () => {
  it('sees an entry the loader ignores as invalid', async () => {
    await writeConfig('[machines.laptop]\nssh = ""\n');

    await expect(hasMachineEntry(configPath, 'laptop')).resolves.toBe(true);
    await expect(hasMachineEntry(configPath, 'vps')).resolves.toBe(false);
  });
});

describe('removeMachineFromConfigFile', () => {
  it('removes only that table, keeping the comments before the next one', async () => {
    const original = [
      'timezone = "UTC"',
      '',
      '[machines.laptop]  # work laptop',
      'ssh = "me@laptop"',
      '',
      '# ---- keep me ----',
      '[machines.vps]',
      'ssh = "vps"',
      '',
    ].join('\n');
    await writeConfig(original);

    await removeMachineFromConfigFile(configPath, 'laptop');

    expect(await readFile(configPath, 'utf8')).toBe(
      ['timezone = "UTC"', '', '# ---- keep me ----', '[machines.vps]', 'ssh = "vps"', ''].join(
        '\n',
      ),
    );

    await removeMachineFromConfigFile(configPath, 'vps');

    expect(await readFile(configPath, 'utf8')).toBe('timezone = "UTC"\n\n# ---- keep me ----\n');
  });

  it('refuses, without writing, when it cannot find the table', async () => {
    const original = 'machines.laptop.ssh = "me@laptop"\n';
    await writeConfig(original);

    await expect(removeMachineFromConfigFile(configPath, 'laptop')).rejects.toThrow(
      'delete its [machines.laptop] table by hand',
    );
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await temporaryFiles()).toEqual([]);
  });
});

describe('concurrent config edits', () => {
  it('keeps every change when runs add and remove machines at the same time', async () => {
    await writeConfig('[machines.old]\nssh = "old"\n');

    await Promise.all([
      addMachineToConfigFile(configPath, 'one', { ssh: 'one' }),
      addMachineToConfigFile(configPath, 'two', { ssh: 'two' }),
      removeMachineFromConfigFile(configPath, 'old'),
    ]);

    const content = await readFile(configPath, 'utf8');
    expect(content).toContain('[machines.one]');
    expect(content).toContain('[machines.two]');
    expect(content).not.toContain('[machines.old]');
    expect(await readdir(path.dirname(configPath))).toEqual(['config.toml']);
  });

  it('waits for a held lock, then names it instead of taking it over', async () => {
    await writeConfig('');
    const lockPath = `${configPath}.lock`;
    await writeFile(lockPath, '');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);

    await expect(addMachineToConfigFile(configPath, 'laptop', { ssh: 'laptop' })).rejects.toThrow(
      `delete ${lockPath} if no other run is`,
    );
    expect(await readFile(configPath, 'utf8')).toBe('');
    await expect(lstat(lockPath)).resolves.toBeDefined();
  }, 15_000);
});
