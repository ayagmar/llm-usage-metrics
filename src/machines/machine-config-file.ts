import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { parse as parseToml } from 'smol-toml';

import { loadUserConfig, type MachineConfig, type UserConfig } from '../config/user-config.js';
import { asRecord } from '../utils/as-record.js';
import { ensureDirectory } from '../utils/fs-helpers.js';
import { hasErrorCode } from '../utils/error-code.js';

async function readConfigText(configPath: string): Promise<string | undefined> {
  try {
    return await readFile(configPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}

async function loadConfigText(configPath: string, content: string): Promise<UserConfig> {
  const loaded = await loadUserConfig({ LLM_USAGE_CONFIG_PATH: configPath }, async () => content);
  return loaded.config;
}

function withoutMachine(config: UserConfig, name: string): UserConfig {
  const machines = Object.fromEntries(
    Object.entries(config.machines ?? {}).filter(([machineName]) => machineName !== name),
  );
  const rest = { ...config };
  delete rest.machines;

  return Object.keys(machines).length === 0 ? rest : { ...rest, machines };
}

const CONFIG_LOCK_RETRY_MS = 50;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
/** A lock this old was left by a process that died mid-edit. */
const CONFIG_LOCK_STALE_MS = 30_000;

/** The file a config edit replaces: a symlinked config's target, not the link. */
async function resolveConfigTarget(configPath: string): Promise<string> {
  return realpath(configPath).catch(() => configPath);
}

/**
 * Runs a read-modify-write of the config file while holding `<target>.lock`, so two
 * `machine add` or `remove` runs cannot each write a file that drops the other's change.
 */
async function withConfigLock<T>(configPath: string, edit: () => Promise<T>): Promise<T> {
  await ensureDirectory(path.dirname(configPath));
  const lockPath = `${await resolveConfigTarget(configPath)}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }

      const lockAgeMs = Date.now() - ((await stat(lockPath).catch(() => undefined))?.mtimeMs ?? 0);

      if (lockAgeMs > CONFIG_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Another llm-usage run is editing ${configPath}; try again, or delete ${lockPath} if none is`,
          { cause: error },
        );
      }

      await sleep(CONFIG_LOCK_RETRY_MS);
    }
  }

  try {
    return await edit();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/**
 * Replaces the file through a rename, so a crash never leaves a half-written config. A
 * symlinked config (e.g. into a dotfiles checkout) has its target replaced, not the link.
 */
async function replaceConfigFile(configPath: string, content: string): Promise<void> {
  const targetPath = await resolveConfigTarget(configPath);
  const mode = (await stat(targetPath).catch(() => undefined))?.mode;
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: mode ?? 0o644 });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Whether the file has a `machines.<name>` entry at all, even one the loader ignores as
 * invalid: appending a second table of that name would not parse.
 */
export async function hasMachineEntry(configPath: string, name: string): Promise<boolean> {
  const content = await readConfigText(configPath);

  try {
    return (
      content !== undefined &&
      asRecord(asRecord(parseToml(content))?.machines)?.[name] !== undefined
    );
  } catch {
    return false;
  }
}

function formatMachineBlock(name: string, machine: MachineConfig, eol = '\n'): string {
  // TOML basic strings use the same escapes as JSON for the characters a destination or
  // command can hold.
  const lines = [`[machines.${name}]`, `ssh = ${JSON.stringify(machine.ssh)}`];

  if (machine.command !== undefined) {
    lines.push(`command = ${JSON.stringify(machine.command)}`);
  }

  return `${lines.join(eol)}${eol}`;
}

/**
 * Appends a `[machines.<name>]` table to the config file, creating the file if needed.
 * Appending keeps the user's comments and layout; the result is read back and must
 * equal the old config plus this machine, or nothing is written.
 */
export async function addMachineToConfigFile(
  configPath: string,
  name: string,
  machine: MachineConfig,
): Promise<void> {
  await withConfigLock(configPath, () => addMachineUnderLock(configPath, name, machine));
}

async function addMachineUnderLock(
  configPath: string,
  name: string,
  machine: MachineConfig,
): Promise<void> {
  const current = (await readConfigText(configPath)) ?? '';
  // Keep a Windows-style file's line endings.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? eol : `${eol}${eol}`;
  const updated = `${current}${separator}${formatMachineBlock(name, machine, eol)}`;
  const before = await loadConfigText(configPath, current);
  let after: UserConfig | undefined;

  try {
    after = await loadConfigText(configPath, updated);
  } catch {
    after = undefined;
  }

  if (
    !after ||
    !isDeepStrictEqual(after.machines?.[name], machine) ||
    !isDeepStrictEqual(withoutMachine(after, name), before)
  ) {
    throw new Error(
      `Could not add [machines.${name}] to ${configPath} safely; add these lines to it by hand:\n${formatMachineBlock(name, machine)}`,
    );
  }

  await replaceConfigFile(configPath, updated);
}

const TABLE_HEADER_PATTERN = /^\s*\[/u;

function isMachineHeader(line: string, name: string): boolean {
  const commentStart = line.indexOf('#');
  const header = (commentStart === -1 ? line : line.slice(0, commentStart)).trim();
  return header === `[machines.${name}]` || header === `[machines."${name}"]`;
}

/**
 * Removes the `[machines.<name>]` table from the config file. The result is read back and
 * must equal the old config without this machine, or nothing is written.
 */
export async function removeMachineFromConfigFile(configPath: string, name: string): Promise<void> {
  await withConfigLock(configPath, () => removeMachineUnderLock(configPath, name));
}

async function removeMachineUnderLock(configPath: string, name: string): Promise<void> {
  const current = (await readConfigText(configPath)) ?? '';
  const lines = current.split('\n');
  const start = lines.findIndex((line) => isMachineHeader(line, name));
  const failure = new Error(
    `Could not remove machine ${name} from ${configPath} safely; delete its [machines.${name}] table by hand`,
  );

  if (start === -1) {
    throw failure;
  }

  const nextTable = lines.findIndex(
    (line, index) => index > start && TABLE_HEADER_PATTERN.test(line),
  );
  const tableEnd = nextTable === -1 ? lines.length : nextTable;
  // The table ends at its last key line; comments and blank lines after it belong to what
  // follows. One blank separator line goes with it.
  let end = start + 1;

  for (let index = start + 1; index < tableEnd; index += 1) {
    const text = lines[index].trim();

    if (text.length > 0 && !text.startsWith('#')) {
      end = index + 1;
    }
  }

  if (end < tableEnd && lines[end].trim() === '') {
    end += 1;
  }

  const isLast = lines.slice(end).every((line) => line.trim() === '');
  // A last table also takes the blank line that separated it from the one before.
  const removeFrom = isLast && start > 0 && lines[start - 1].trim() === '' ? start - 1 : start;
  const kept = [...lines.slice(0, removeFrom), ...lines.slice(isLast ? lines.length : end)].join(
    '\n',
  );
  const updated =
    kept.length > 0 && current.endsWith('\n') && !kept.endsWith('\n') ? `${kept}\n` : kept;
  const before = await loadConfigText(configPath, current);
  let after: UserConfig | undefined;

  try {
    after = await loadConfigText(configPath, updated);
  } catch {
    after = undefined;
  }

  if (!after || !isDeepStrictEqual(after, withoutMachine(before, name))) {
    throw failure;
  }

  await replaceConfigFile(configPath, updated);
}
