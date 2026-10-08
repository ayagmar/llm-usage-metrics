import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { runMachineExport } from '../../src/cli/run-machine-export.js';
import { loadUserConfig } from '../../src/config/user-config.js';
import type { SpawnSsh, SshProcess } from '../../src/machines/machine-ssh.js';

export type InProcessRemote = {
  spawnSsh: SpawnSsh;
  calls: string[][];
  /** The calls that were killed. */
  killed: string[][];
};

/**
 * Stands in for `ssh <host> llm-usage machine export --known -`: runs the real export
 * in-process against the remote's own config and ledger. `rewrite` edits the bundle the
 * remote prints; `fail` makes the remote command exit with that code and stderr.
 */
export function createInProcessRemote(options: {
  configPath: string;
  eventStorePath: string;
  rewrite?: (bundle: string) => string;
  fail?: { exitCode: number; stderr: string };
  /** What the command probe prints, e.g. a login-shell-only path after the probe marker. */
  loginShellCommand?: string;
  /** A warning the remote prints on stderr while succeeding. */
  warning?: string;
  /** The export never finishes; only a kill ends it. */
  hang?: boolean;
}): InProcessRemote {
  const calls: string[][] = [];
  const killed: string[][] = [];

  const spawnSsh: SpawnSsh = (args) => {
    calls.push([...args]);
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const close = (exitCode: number | null) => {
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit('close', exitCode));
    };

    void (async () => {
      // `machine add` first asks where llm-usage is; here it is on the ssh PATH.
      if (!args.at(-1)?.includes('machine export')) {
        stdout.write(`${options.loginShellCommand ?? '/usr/bin/llm-usage'}\n`);
        close(0);
        return;
      }

      if (options.hang) {
        return;
      }

      if (options.fail) {
        stderr.write(options.fail.stderr);
        close(options.fail.exitCode);
        return;
      }

      const bundle = new PassThrough();
      const chunks: Buffer[] = [];
      bundle.on('data', (chunk: Buffer) => chunks.push(chunk));

      try {
        await runMachineExport(
          { known: '-' },
          {
            stdin,
            stdout: bundle,
            loadUserConfig: () => loadUserConfig({ LLM_USAGE_CONFIG_PATH: options.configPath }),
            getEventStoreRuntimeConfig: () => ({ enabled: true, path: options.eventStorePath }),
          },
        );
      } catch (error) {
        stderr.write(String(error));
        close(1);
        return;
      }

      const text = Buffer.concat(chunks).toString('utf8');
      stdout.write(options.rewrite ? options.rewrite(text) : text);

      if (options.warning) {
        stderr.write(`${options.warning}\n`);
      }

      close(0);
    })();

    const sshProcess: SshProcess = {
      stdin,
      stdout,
      stderr,
      kill: () => {
        killed.push([...args]);
        close(null);
        return true;
      },
      once: emitter.once.bind(emitter),
    };

    return sshProcess;
  };

  return { spawnSsh, calls, killed };
}

/** Appends a turn whose cumulative totals grew, so the session has one more event. */
export async function appendCodexTurn(codexFile: string): Promise<void> {
  const turn = {
    timestamp: '2026-02-03T08:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 300,
          cached_input_tokens: 70,
          output_tokens: 150,
          reasoning_output_tokens: 30,
          total_tokens: 550,
        },
      },
    },
  };
  await writeFile(
    codexFile,
    `${(await readFile(codexFile, 'utf8')).trimEnd()}\n${JSON.stringify(turn)}\n`,
  );
}
