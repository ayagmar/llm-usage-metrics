import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  describeExportFailure,
  detectRemoteCommand,
  fetchMachineExport,
  type SpawnSsh,
  type SshProcess,
} from '../../src/machines/machine-ssh.js';

/** A process that prints `stdout`/`stderr`, then exits with `exitCode`, or never exits. */
function fakeSsh(output: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  hang?: boolean;
  spawnError?: Error;
}): {
  spawnSsh: SpawnSsh;
  killed: () => boolean;
} {
  let killed = false;

  const spawnSsh: SpawnSsh = () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const close = (exitCode: number | null) => {
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit('close', exitCode));
    };

    setImmediate(() => {
      if (output.spawnError) {
        stdout.end();
        stderr.end();
        emitter.emit('error', output.spawnError);
        return;
      }

      stdout.write(output.stdout ?? '');
      stderr.write(output.stderr ?? '');

      if (!output.hang) {
        close(output.exitCode ?? 0);
      }
    });

    const sshProcess: SshProcess = {
      stdin: new PassThrough(),
      stdout,
      stderr,
      kill: () => {
        killed = true;
        close(null);
        return true;
      },
      once: emitter.once.bind(emitter),
    };

    return sshProcess;
  };

  return { spawnSsh, killed: () => killed };
}

const machine = { ssh: 'me@laptop' };

describe('fetchMachineExport', () => {
  it('pipes the known files to a real process and reads its bundle', async () => {
    // Stands in for ssh: echoes the known files it received back as the end line.
    const script = [
      'let input = "";',
      'process.stdin.on("data", (chunk) => (input += chunk));',
      'process.stdin.on("end", () => {',
      '  const { files } = JSON.parse(input);',
      '  console.log(JSON.stringify({ type: "header", format: "llm-usage-metrics.machine-export", version: 1 }));',
      '  console.log(JSON.stringify({ type: "end", files, eventCount: 0 }));',
      '});',
    ].join('\n');
    const known: [string, string, string][] = [['codex', '/a.jsonl', 'r1']];

    const bundle = await fetchMachineExport(machine, known, {
      spawnSsh: () => spawn(process.execPath, ['-e', script]),
    });

    expect(bundle.files).toEqual(known);
  });

  it('reports a missing ssh binary', async () => {
    const { spawnSsh } = fakeSsh({ spawnError: new Error('spawn ssh ENOENT') });

    await expect(fetchMachineExport(machine, [], { spawnSsh })).rejects.toThrow(
      'could not run ssh: spawn ssh ENOENT',
    );
  });

  it('kills a remote that does not finish in time', async () => {
    const { spawnSsh, killed } = fakeSsh({ hang: true });

    await expect(fetchMachineExport(machine, [], { spawnSsh, timeoutMs: 20 })).rejects.toThrow(
      'no complete export within 0s',
    );
    expect(killed()).toBe(true);
  });

  it('names the failure the remote command reported', async () => {
    const { spawnSsh } = fakeSsh({
      stdout: 'partial',
      stderr: 'bash: line 1: llm-usage: command not found\n',
      exitCode: 127,
    });

    await expect(fetchMachineExport(machine, [], { spawnSsh })).rejects.toThrow(
      'llm-usage was not found on me@laptop: bash: line 1: llm-usage: command not found. Install llm-usage-metrics there, or give the command that starts it (machine add --command, or command in config.toml).',
    );
  });

  it('rejects an export cut off by a signal', async () => {
    const { spawnSsh } = fakeSsh({ stdout: '', exitCode: null });

    await expect(fetchMachineExport(machine, [], { spawnSsh })).rejects.toThrow(
      'the export from me@laptop is invalid: the output is not a machine export (no header line)',
    );
  });
});

describe('describeExportFailure', () => {
  it.each([
    [255, 'Host key verification failed.', 'Connect once with `ssh me@laptop`'],
    [
      255,
      'ssh: Could not resolve hostname laptop',
      'ssh failed: ssh: Could not resolve hostname laptop',
    ],
    [1, "error: unknown command 'machine'", 'too old to export usage'],
    [1, '', 'machine export failed: exit code 1'],
  ])('explains exit %i with "%s"', (exitCode, stderr, message) => {
    expect(describeExportFailure(machine, exitCode, stderr)).toContain(message);
  });
});

describe('detectRemoteCommand', () => {
  const printing = (stdout: string) => () =>
    spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)})`]);
  const marker = 'llm-usage-metrics: asking the login shell';

  it.each([
    ['the ssh PATH has llm-usage', '/usr/local/bin/llm-usage\n', undefined],
    [
      'only the login shell has it',
      `${marker}\nWelcome back\n/home/me/.nvm/versions/node/v24.1.0/bin/llm-usage\n`,
      'env PATH=/home/me/.nvm/versions/node/v24.1.0/bin:"$PATH" llm-usage',
    ],
    ['neither has it', `${marker}\n`, undefined],
    [
      'it lives in a path that needs quoting',
      `${marker}\n/home/me/my tools/llm-usage\n`,
      undefined,
    ],
  ])('when %s', async (_name, stdout, expected) => {
    await expect(detectRemoteCommand('me@laptop', { spawnSsh: printing(stdout) })).resolves.toBe(
      expected,
    );
  });

  it('gives up when ssh cannot run', async () => {
    const { spawnSsh } = fakeSsh({ spawnError: new Error('spawn ssh ENOENT') });

    await expect(detectRemoteCommand('me@laptop', { spawnSsh })).resolves.toBeUndefined();
  });
});
