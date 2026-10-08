import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addMachineToConfigFile,
  removeMachineFromConfigFile,
} from '../../src/machines/machine-config-file.js';
import { pathExists } from '../../src/utils/fs-helpers.js';

let rootDir: string;
let configPath: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'machine-config-'));
  configPath = path.join(rootDir, 'llm-usage-metrics', 'config.toml');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('addMachineToConfigFile', () => {
  it('creates the config file when there is none', async () => {
    await addMachineToConfigFile(configPath, 'laptop', { ssh: 'me@laptop' });

    expect(await readFile(configPath, 'utf8')).toBe('[machines.laptop]\nssh = "me@laptop"\n');
  });

  it('appends after the existing text, with the command when one is given', async () => {
    await addMachineToConfigFile(configPath, 'a', { ssh: 'a' });
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}# trailing comment`);

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
    await addMachineToConfigFile(configPath, 'a', { ssh: 'a' });
    await writeFile(configPath, original);

    await expect(addMachineToConfigFile(configPath, 'b', { ssh: 'b' })).rejects.toThrow(
      'add these lines to it by hand:\n[machines.b]\nssh = "b"\n',
    );
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});

describe('removeMachineFromConfigFile', () => {
  it('removes only that table, up to the next one', async () => {
    const original = [
      'timezone = "UTC"',
      '',
      '[machines.laptop]  # work laptop',
      'ssh = "me@laptop"',
      '',
      '[machines.vps]',
      'ssh = "vps"',
      '',
    ].join('\n');
    await addMachineToConfigFile(configPath, 'x', { ssh: 'x' });
    await writeFile(configPath, original);

    await removeMachineFromConfigFile(configPath, 'laptop');

    expect(await readFile(configPath, 'utf8')).toBe(
      ['timezone = "UTC"', '', '[machines.vps]', 'ssh = "vps"', ''].join('\n'),
    );

    await removeMachineFromConfigFile(configPath, 'vps');

    expect(await readFile(configPath, 'utf8')).toBe('timezone = "UTC"\n');
  });

  it('refuses, without writing, when it cannot find the table', async () => {
    const original = 'machines.laptop.ssh = "me@laptop"\n';
    await addMachineToConfigFile(configPath, 'x', { ssh: 'x' });
    await writeFile(configPath, original);

    await expect(removeMachineFromConfigFile(configPath, 'laptop')).rejects.toThrow(
      'delete its [machines.laptop] table by hand',
    );
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await pathExists(path.join(path.dirname(configPath), 'config.toml.tmp'))).toBe(false);
  });
});
