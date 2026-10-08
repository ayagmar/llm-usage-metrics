import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadUserConfig, type MachineConfig, type UserConfig } from '../config/user-config.js';
import { ensureDirectory } from '../utils/fs-helpers.js';

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readConfigText(configPath: string): Promise<string | undefined> {
  try {
    return await readFile(configPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
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

/** Replaces the file through a rename, so a crash never leaves a half-written config. */
async function replaceConfigFile(configPath: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(configPath));
  const mode = (await stat(configPath).catch(() => undefined))?.mode;
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: mode ?? 0o644 });
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function formatMachineBlock(name: string, machine: MachineConfig): string {
  // TOML basic strings use the same escapes as JSON for the characters a destination or
  // command can hold.
  const lines = [`[machines.${name}]`, `ssh = ${JSON.stringify(machine.ssh)}`];

  if (machine.command !== undefined) {
    lines.push(`command = ${JSON.stringify(machine.command)}`);
  }

  return `${lines.join('\n')}\n`;
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
  const current = (await readConfigText(configPath)) ?? '';
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const updated = `${current}${separator}${formatMachineBlock(name, machine)}`;
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
  const end = nextTable === -1 ? lines.length : nextTable;
  // A table runs up to the next one, blank lines included; a last table also takes the
  // blank line that separated it from the one before.
  const removeFrom =
    end === lines.length && start > 0 && lines[start - 1].trim() === '' ? start - 1 : start;
  const kept = [...lines.slice(0, removeFrom), ...lines.slice(end)].join('\n');
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
