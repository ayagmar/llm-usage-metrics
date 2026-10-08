import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import type { MachineConfig } from '../config/user-config.js';
import { stripControlCharacters } from '../domain/normalization.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import {
  MACHINE_EXPORT_VERSION,
  readMachineExport,
  type MachineExportFileKey,
  type ParsedMachineExport,
} from './machine-export-bundle.js';

export const DEFAULT_MACHINE_COMMAND = 'llm-usage';

const STDERR_TAIL_BYTES = 4096;

/** The part of a child process the sync uses, so tests can stand in for ssh. */
export type SshProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: () => boolean;
  once(event: 'close', listener: (exitCode: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
};

export type SpawnSsh = (args: readonly string[]) => SshProcess;

const spawnSystemSsh: SpawnSsh = (args) =>
  spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

/**
 * ssh never prompts (BatchMode): a sync runs inside reports, where a password or host-key
 * prompt would hang. Keepalives end a dead connection; options from ~/.ssh/config, such
 * as ControlMaster, still apply. `--` keeps a destination from being read as an option.
 */
function buildSshArgs(target: string, remoteCommand: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'Compression=yes',
    '--',
    target,
    remoteCommand,
  ];
}

export function buildSshExportArgs(machine: MachineConfig): string[] {
  return buildSshArgs(
    machine.ssh,
    `${machine.command ?? DEFAULT_MACHINE_COMMAND} machine export --known - --quiet`,
  );
}

const LOGIN_SHELL_MARKER = 'llm-usage-metrics: asking the login shell';
const PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * Finds how to launch llm-usage on another machine when ssh commands cannot. Version
 * managers (nvm, fnm, volta, mise) put node on PATH in shell startup files, which a
 * non-interactive ssh session skips; a command only the login shell finds is launched
 * with its directory on PATH. Undefined means the default command works or nothing
 * better was found.
 */
export async function detectRemoteCommand(
  target: string,
  options: { spawnSsh?: SpawnSsh; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const probe = [
    `command -v ${DEFAULT_MACHINE_COMMAND} && exit 0`,
    `echo '${LOGIN_SHELL_MARKER}'`,
    `"$SHELL" -lic 'command -v ${DEFAULT_MACHINE_COMMAND}'`,
  ].join('; ');
  const child = (options.spawnSsh ?? spawnSystemSsh)(buildSshArgs(target, probe));
  let output = '';
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20_000);

  child.stdin.on('error', () => undefined);
  child.stdin.end();
  child.stdout.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-PROBE_OUTPUT_BYTES);
  });
  child.stderr.resume();

  try {
    // A failed probe only means nothing better was found.
    await new Promise<void>((resolve) => {
      child.once('error', () => {
        resolve();
      });
      child.once('close', () => {
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
  }

  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const markerIndex = lines.indexOf(LOGIN_SHELL_MARKER);
  const suffix = `/${DEFAULT_MACHINE_COMMAND}`;
  const found = lines
    .slice(markerIndex + 1)
    .filter((line) => line.startsWith('/') && line.endsWith(suffix))
    .at(-1);

  if (markerIndex === -1 || !found || !/^[\w./+@-]+$/u.test(found)) {
    return undefined;
  }

  return `env PATH=${found.slice(0, -suffix.length)}:"$PATH" ${DEFAULT_MACHINE_COMMAND}`;
}

function readStderrTail(chunks: readonly Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8').slice(-STDERR_TAIL_BYTES);
  return stripControlCharacters(text.replaceAll(/\s+/gu, ' ')).trim();
}

/** Names what failed and, when the cause is a known one, how to fix it. */
export function describeExportFailure(
  machine: MachineConfig,
  exitCode: number | null,
  stderr: string,
): string {
  const command = machine.command ?? DEFAULT_MACHINE_COMMAND;
  // Hints follow as their own sentence, so the detail's own final period is dropped.
  const detail = (stderr || `exit code ${String(exitCode)}`).replace(/\.$/u, '');

  if (/permission denied|too many authentication failures/iu.test(stderr)) {
    return `ssh could not log in without a prompt: ${detail}. Set up key login (ssh-copy-id ${machine.ssh}) or load your key into ssh-agent.`;
  }

  if (/host key verification failed/iu.test(stderr)) {
    return `ssh does not know this host yet: ${detail}. Connect once with \`ssh ${machine.ssh}\` to check and accept its host key.`;
  }

  if (exitCode === 255) {
    return `ssh failed: ${detail}`;
  }

  if (exitCode === 127 || /command not found|not recognized as an internal/iu.test(stderr)) {
    return `${command} was not found on ${machine.ssh}: ${detail}. Install llm-usage-metrics there, or give the command that starts it (machine add --command, or command in config.toml).`;
  }

  if (/unknown command 'machine'|unknown command 'export'/iu.test(stderr)) {
    return `${command} on ${machine.ssh} is too old to export usage: ${detail}. Update llm-usage-metrics there.`;
  }

  return `machine export failed: ${detail}`;
}

/**
 * Runs `machine export` on another machine over ssh, sending the files the cache holds,
 * and returns the validated bundle. It throws on any failure; a partial bundle never
 * returns.
 */
export async function fetchMachineExport(
  machine: MachineConfig,
  knownFiles: readonly MachineExportFileKey[],
  options: { spawnSsh?: SpawnSsh; timeoutMs?: number } = {},
): Promise<ParsedMachineExport> {
  const child = (options.spawnSsh ?? spawnSystemSsh)(buildSshExportArgs(machine));
  const stderrChunks: Buffer[] = [];
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timeout = { expired: false };
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timeout.expired = true;
          child.kill();
        }, options.timeoutMs);

  let stderrBytes = 0;

  // Only the tail explains a failure; a chatty remote must not grow memory without bound.
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;

    while (stderrBytes > STDERR_TAIL_BYTES * 4 && stderrChunks.length > 1) {
      stderrBytes -= stderrChunks.shift()?.length ?? 0;
    }
  });
  // ssh may exit before reading its input; the exit status reports why.
  child.stdin.on('error', () => undefined);
  child.stdin.end(JSON.stringify({ version: MACHINE_EXPORT_VERSION, files: knownFiles }));

  let bundle: ParsedMachineExport | undefined;
  let readError: unknown;

  try {
    bundle = await readMachineExport(createInterface({ input: child.stdout, crlfDelay: Infinity }));
  } catch (error) {
    readError = error;
    child.kill();
  }

  let exitCode: number | null;

  try {
    exitCode = await closed;
  } catch (error) {
    // The spawn itself failed, e.g. no ssh on PATH.
    throw new Error(`could not run ssh: ${getErrorReason(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (timeout.expired) {
    throw new Error(`no complete export within ${Math.round((options.timeoutMs ?? 0) / 1000)}s`);
  }

  // A failing remote command explains itself on stderr; a bundle cut short by it does not.
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(describeExportFailure(machine, exitCode, readStderrTail(stderrChunks)));
  }

  if (!bundle) {
    throw new Error(`the export from ${machine.ssh} is invalid: ${getErrorReason(readError)}`, {
      cause: readError,
    });
  }

  if (exitCode !== 0) {
    throw new Error(describeExportFailure(machine, exitCode, readStderrTail(stderrChunks)));
  }

  return bundle;
}
