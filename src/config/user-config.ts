import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { asRecord } from '../utils/as-record.js';
import { readRegularTextFile } from '../utils/fs-helpers.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getUserConfigRootDir } from '../utils/config-root-dir.js';
import type { LogLevel } from '../utils/logger.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRICING_CACHE_TTL_MIN_MS = MINUTE_MS;
const PRICING_CACHE_TTL_MAX_MS = 30 * DAY_MS;
const PRICING_FETCH_TIMEOUT_MIN_MS = 200;
const PRICING_FETCH_TIMEOUT_MAX_MS = 30_000;
const UPDATE_CACHE_TTL_MIN_MS = 0;
const UPDATE_CACHE_TTL_MAX_MS = 30 * DAY_MS;
const UPDATE_FETCH_TIMEOUT_MIN_MS = 200;
const UPDATE_FETCH_TIMEOUT_MAX_MS = 30_000;
const PARSE_MAX_PARALLEL_MIN = 1;
const PARSE_MAX_PARALLEL_MAX = 64;
const PARSE_WORKERS_MIN = 0;
const PARSE_WORKERS_MAX = 64;
const PARSE_WORKER_MIN_BYTES_MIN = 0;
const PARSE_WORKER_MIN_BYTES_MAX = Number.MAX_SAFE_INTEGER;

export const USER_CONFIG_SOURCE_DIR_KEYS = [
  'pi',
  'codex',
  'copilot',
  'gemini',
  'droid',
  'claude',
  'openclaw',
  'opencode',
  'goose',
  'amp',
  'qwen',
  'kimi',
  'cline',
  'roocode',
  'kilocode',
  'antigravity',
  'dsh',
] as const;

const knownTopLevelKeys = [
  'eventStore',
  'logLevel',
  'machines',
  'monthlyBudgetUsd',
  'parseMaxParallel',
  'parseWorkerMinBytes',
  'parseWorkers',
  'pricing',
  'sourceDirs',
  'sources',
  'timezone',
  'update',
] as const;

const knownPricingKeys = [
  'cacheTtlMs',
  'fetchTimeoutMs',
  'ignoreFailures',
  'offline',
  'overridesPath',
  'url',
] as const;
const knownEventStoreKeys = ['enabled', 'path'] as const;
const knownUpdateKeys = ['cacheTtlMs', 'fetchTimeoutMs', 'skipCheck'] as const;
const knownMachineKeys = ['command', 'enabled', 'ssh'] as const;

export const USER_CONFIG_KNOWN_KEY_PATHS = [
  ...knownTopLevelKeys,
  ...knownPricingKeys.map((key) => `pricing.${key}`),
  ...knownEventStoreKeys.map((key) => `eventStore.${key}`),
  ...knownUpdateKeys.map((key) => `update.${key}`),
  ...knownMachineKeys.map((key) => `machines.<name>.${key}`),
  ...USER_CONFIG_SOURCE_DIR_KEYS.map((key) => `sourceDirs.${key}`),
] as const;

const knownTopLevelKeySet = new Set<string>(knownTopLevelKeys);
const knownPricingKeySet = new Set<string>(knownPricingKeys);
const knownEventStoreKeySet = new Set<string>(knownEventStoreKeys);
const knownUpdateKeySet = new Set<string>(knownUpdateKeys);
const knownMachineKeySet = new Set<string>(knownMachineKeys);

import { LOCAL_MACHINE_NAME } from '../domain/usage-event.js';

export { LOCAL_MACHINE_NAME };
const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export function isValidMachineName(name: string): boolean {
  return MACHINE_NAME_PATTERN.test(name) && name !== LOCAL_MACHINE_NAME;
}

/**
 * An ssh destination (`host`, `user@host`, an ssh_config alias or `ssh://` URI). A
 * leading `-` would be read as an ssh option, and whitespace or control characters
 * never belong in one.
 */
export function isValidSshTarget(target: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  return target.length > 0 && !target.startsWith('-') && !/[\s\u0000-\u001F\u007F]/u.test(target);
}

export type MachineConfig = {
  /** The ssh destination. */
  ssh: string;
  /** How the CLI is launched on that machine; defaults to `llm-usage`. */
  command?: string;
  /** `false` keeps the machine's cached usage but stops syncing it. */
  enabled?: boolean;
};
const sourceDirKeySet = new Set<string>(USER_CONFIG_SOURCE_DIR_KEYS);

export type UserConfig = {
  timezone?: string;
  logLevel?: LogLevel;
  /** Monthly spending budget; summary warns when the month-end projection exceeds it. */
  monthlyBudgetUsd?: number;
  sources?: string[];
  /** A directory-backed source may list several directories; database paths take one. */
  sourceDirs?: Partial<Record<(typeof USER_CONFIG_SOURCE_DIR_KEYS)[number], string | string[]>>;
  pricing?: {
    offline?: boolean;
    url?: string;
    overridesPath?: string;
    ignoreFailures?: boolean;
    cacheTtlMs?: number;
    fetchTimeoutMs?: number;
  };
  eventStore?: {
    enabled?: boolean;
    path?: string;
  };
  parseMaxParallel?: number;
  parseWorkers?: 'auto' | number;
  parseWorkerMinBytes?: number;
  update?: {
    skipCheck?: boolean;
    cacheTtlMs?: number;
    fetchTimeoutMs?: number;
  };
  /** Other machines whose usage reports include, by name. */
  machines?: Record<string, MachineConfig>;
};

export type LoadedUserConfig = {
  config: UserConfig;
  path: string;
  exists: boolean;
  warnings: string[];
};

type ReadConfigFile = (filePath: string) => Promise<string>;

function getDefaultUserConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(
    getUserConfigRootDir(env, process.platform, os.homedir()),
    'llm-usage-metrics',
    'config.toml',
  );
}

export function resolveUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const overridePath = env.LLM_USAGE_CONFIG_PATH?.trim();

  if (overridePath) {
    return overridePath;
  }

  return getDefaultUserConfigPath(env);
}

function isMissingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT';
}

function hasConfigPathOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LLM_USAGE_CONFIG_PATH?.trim());
}

function getLegacyJsonConfigPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'config.json');
}

async function throwIfLegacyJsonConfigExists(
  tomlPath: string,
  readFile: ReadConfigFile,
): Promise<void> {
  const jsonPath = getLegacyJsonConfigPath(tomlPath);

  try {
    await readFile(jsonPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  throw new Error(
    `Legacy JSON config found at ${jsonPath}. The config format is now TOML: create ${tomlPath} with the same settings (run \`llm-usage config init\` for a commented template), then remove the old file.`,
  );
}

function collectUnknownKeys(
  record: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  prefix = '',
): string[] {
  return Object.keys(record)
    .filter((key) => !knownKeys.has(key))
    .map((key) => `${prefix}${key}`);
}

function pushUnknownNestedKeys(
  unknownKeys: string[],
  root: Record<string, unknown>,
  key: string,
  knownKeys: ReadonlySet<string>,
): void {
  const nested = asRecord(root[key]);

  if (!nested) {
    return;
  }

  unknownKeys.push(...collectUnknownKeys(nested, knownKeys, `${key}.`));
}

function formatUnknownKeyWarning(unknownKeys: string[]): string | undefined {
  if (unknownKeys.length === 0) {
    return undefined;
  }

  const sortedKeys = [...new Set(unknownKeys)].sort(compareByCodePoint);
  return `Unknown config key(s): ${sortedKeys.join(', ')}`;
}

type ConfigReadContext = {
  configDir: string;
  warnings: string[];
};

/** Blank strings and empty lists, as in the `config init` template, mean "not set". */
function isUnset(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Reads one config value and warns when it is set but has the wrong type. */
function readKey<T>(
  context: ConfigReadContext,
  keyPath: string,
  value: unknown,
  read: (value: unknown) => T | undefined,
  expected: string,
): T | undefined {
  if (isUnset(value)) {
    return undefined;
  }

  const result = read(value);

  if (result === undefined) {
    context.warnings.push(`Ignoring ${keyPath}: expected ${expected}`);
  }

  return result;
}

function readTable(
  context: ConfigReadContext,
  keyPath: string,
  value: unknown,
): Record<string, unknown> | undefined {
  return readKey(context, keyPath, value, asRecord, 'a table');
}

function clampInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    return undefined;
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

function readInteger(
  context: ConfigReadContext,
  keyPath: string,
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  return readKey(context, keyPath, value, (v) => clampInteger(v, min, max), 'an integer');
}

function toNonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length === 0 ? undefined : trimmedValue;
}

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Config paths may start with `~` and resolve against the config file, not the cwd. */
function resolveConfigPath(value: string, configDir: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.resolve(configDir, value);
}

function readPath(context: ConfigReadContext, keyPath: string, value: unknown): string | undefined {
  const text = readKey(context, keyPath, value, toNonBlankString, 'a non-empty path');
  return text === undefined ? undefined : resolveConfigPath(text, context.configDir);
}

function readLogLevel(value: unknown): LogLevel | undefined {
  if (value === 'silent' || value === 'warn' || value === 'info' || value === 'debug') {
    return value;
  }

  return undefined;
}

function toSources(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sources = value.flatMap((candidate) => {
    const source = toNonBlankString(candidate);
    return source === undefined ? [] : [source];
  });

  if (sources.length === 0) {
    return undefined;
  }

  return [...new Set(sources)];
}

/** SQLite sources read one database file, so their config value stays a single path. */
const singlePathSourceDirKeys = new Set<string>(['opencode', 'goose']);

function readSourceDirValue(
  context: ConfigReadContext,
  sourceId: string,
  value: unknown,
): string | string[] | undefined {
  const keyPath = `sourceDirs.${sourceId}`;

  if (!Array.isArray(value)) {
    return readPath(context, keyPath, value);
  }

  if (singlePathSourceDirKeys.has(sourceId)) {
    context.warnings.push(`Ignoring ${keyPath}: it takes one database path, not a list`);
    return undefined;
  }

  const directories = value.flatMap((entry) => {
    const directory = toNonBlankString(entry);
    return directory === undefined ? [] : [resolveConfigPath(directory, context.configDir)];
  });

  if (directories.length === 0) {
    context.warnings.push(`Ignoring ${keyPath}: expected a non-empty path or list of paths`);
    return undefined;
  }

  return directories;
}

function readSourceDirs(
  context: ConfigReadContext,
  value: unknown,
): UserConfig['sourceDirs'] | undefined {
  const record = readTable(context, 'sourceDirs', value);

  if (!record) {
    return undefined;
  }

  const sourceDirs: UserConfig['sourceDirs'] = {};

  for (const sourceId of USER_CONFIG_SOURCE_DIR_KEYS) {
    const sourceDir = isUnset(record[sourceId])
      ? undefined
      : readSourceDirValue(context, sourceId, record[sourceId]);

    if (sourceDir !== undefined) {
      sourceDirs[sourceId] = sourceDir;
    }
  }

  return Object.keys(sourceDirs).length === 0 ? undefined : sourceDirs;
}

function readPricingConfig(
  context: ConfigReadContext,
  value: unknown,
): UserConfig['pricing'] | undefined {
  const record = readTable(context, 'pricing', value);

  if (!record) {
    return undefined;
  }

  const pricing: UserConfig['pricing'] = {};
  const offline = readKey(context, 'pricing.offline', record.offline, toBoolean, 'true or false');
  const url = readKey(context, 'pricing.url', record.url, toNonBlankString, 'a non-empty URL');
  const overridesPath = readPath(context, 'pricing.overridesPath', record.overridesPath);
  const ignoreFailures = readKey(
    context,
    'pricing.ignoreFailures',
    record.ignoreFailures,
    toBoolean,
    'true or false',
  );
  const cacheTtlMs = readInteger(
    context,
    'pricing.cacheTtlMs',
    record.cacheTtlMs,
    PRICING_CACHE_TTL_MIN_MS,
    PRICING_CACHE_TTL_MAX_MS,
  );
  const fetchTimeoutMs = readInteger(
    context,
    'pricing.fetchTimeoutMs',
    record.fetchTimeoutMs,
    PRICING_FETCH_TIMEOUT_MIN_MS,
    PRICING_FETCH_TIMEOUT_MAX_MS,
  );

  if (offline !== undefined) {
    pricing.offline = offline;
  }

  if (url !== undefined) {
    pricing.url = url;
  }

  if (overridesPath !== undefined) {
    pricing.overridesPath = overridesPath;
  }

  if (ignoreFailures !== undefined) {
    pricing.ignoreFailures = ignoreFailures;
  }

  if (cacheTtlMs !== undefined) {
    pricing.cacheTtlMs = cacheTtlMs;
  }

  if (fetchTimeoutMs !== undefined) {
    pricing.fetchTimeoutMs = fetchTimeoutMs;
  }

  return Object.keys(pricing).length === 0 ? undefined : pricing;
}

function readEventStoreConfig(
  context: ConfigReadContext,
  value: unknown,
): UserConfig['eventStore'] | undefined {
  const record = readTable(context, 'eventStore', value);

  if (!record) {
    return undefined;
  }

  const eventStore: UserConfig['eventStore'] = {};
  const enabled = readKey(
    context,
    'eventStore.enabled',
    record.enabled,
    toBoolean,
    'true or false',
  );
  const pathValue = readPath(context, 'eventStore.path', record.path);

  if (enabled !== undefined) {
    eventStore.enabled = enabled;
  }

  if (pathValue !== undefined) {
    eventStore.path = pathValue;
  }

  return Object.keys(eventStore).length === 0 ? undefined : eventStore;
}

function readUpdateConfig(
  context: ConfigReadContext,
  value: unknown,
): UserConfig['update'] | undefined {
  const record = readTable(context, 'update', value);

  if (!record) {
    return undefined;
  }

  const update: UserConfig['update'] = {};
  const skipCheck = readKey(
    context,
    'update.skipCheck',
    record.skipCheck,
    toBoolean,
    'true or false',
  );
  const cacheTtlMs = readInteger(
    context,
    'update.cacheTtlMs',
    record.cacheTtlMs,
    UPDATE_CACHE_TTL_MIN_MS,
    UPDATE_CACHE_TTL_MAX_MS,
  );
  const fetchTimeoutMs = readInteger(
    context,
    'update.fetchTimeoutMs',
    record.fetchTimeoutMs,
    UPDATE_FETCH_TIMEOUT_MIN_MS,
    UPDATE_FETCH_TIMEOUT_MAX_MS,
  );

  if (skipCheck !== undefined) {
    update.skipCheck = skipCheck;
  }

  if (cacheTtlMs !== undefined) {
    update.cacheTtlMs = cacheTtlMs;
  }

  if (fetchTimeoutMs !== undefined) {
    update.fetchTimeoutMs = fetchTimeoutMs;
  }

  return Object.keys(update).length === 0 ? undefined : update;
}

function readMachinesConfig(
  context: ConfigReadContext,
  value: unknown,
): UserConfig['machines'] | undefined {
  const record = readTable(context, 'machines', value);

  if (!record) {
    return undefined;
  }

  const machines: Record<string, MachineConfig> = {};

  for (const [name, machineValue] of Object.entries(record)) {
    const keyPath = `machines.${name}`;

    if (!isValidMachineName(name)) {
      context.warnings.push(
        `Ignoring ${keyPath}: a machine name is 1-32 lowercase letters, digits or dashes, and not "${LOCAL_MACHINE_NAME}"`,
      );
      continue;
    }

    const machineRecord = readTable(context, keyPath, machineValue);

    if (!machineRecord) {
      continue;
    }

    const ssh = readKey(
      context,
      `${keyPath}.ssh`,
      machineRecord.ssh,
      (target) => {
        const text = toNonBlankString(target);
        return text !== undefined && isValidSshTarget(text) ? text : undefined;
      },
      'an ssh destination such as "user@host" (no spaces, not starting with -)',
    );

    if (ssh === undefined) {
      if (isUnset(machineRecord.ssh)) {
        context.warnings.push(`Ignoring ${keyPath}: set ssh = "user@host"`);
      }

      continue;
    }

    const machine: MachineConfig = { ssh };
    const command = readKey(
      context,
      `${keyPath}.command`,
      machineRecord.command,
      toNonBlankString,
      'a non-empty command',
    );
    const enabled = readKey(
      context,
      `${keyPath}.enabled`,
      machineRecord.enabled,
      toBoolean,
      'true or false',
    );

    if (command !== undefined) {
      machine.command = command;
    }

    if (enabled !== undefined) {
      machine.enabled = enabled;
    }

    machines[name] = machine;
  }

  return Object.keys(machines).length === 0 ? undefined : machines;
}

function readParseWorkers(value: unknown): UserConfig['parseWorkers'] | undefined {
  if (value === 'auto') {
    return 'auto';
  }

  return clampInteger(value, PARSE_WORKERS_MIN, PARSE_WORKERS_MAX);
}

function readConfig(context: ConfigReadContext, root: Record<string, unknown>): UserConfig {
  const config: UserConfig = {};
  const timezone = readKey(
    context,
    'timezone',
    root.timezone,
    toNonBlankString,
    'a non-empty string',
  );
  const logLevel = readKey(
    context,
    'logLevel',
    root.logLevel,
    readLogLevel,
    'one of silent, warn, info, debug',
  );
  const monthlyBudgetUsd = readKey(
    context,
    'monthlyBudgetUsd',
    root.monthlyBudgetUsd,
    toPositiveNumber,
    'a positive number',
  );
  const sources = readKey(context, 'sources', root.sources, toSources, 'a list of source ids');
  const sourceDirs = readSourceDirs(context, root.sourceDirs);
  const pricing = readPricingConfig(context, root.pricing);
  const eventStore = readEventStoreConfig(context, root.eventStore);
  const parseMaxParallel = readInteger(
    context,
    'parseMaxParallel',
    root.parseMaxParallel,
    PARSE_MAX_PARALLEL_MIN,
    PARSE_MAX_PARALLEL_MAX,
  );
  const parseWorkers = readKey(
    context,
    'parseWorkers',
    root.parseWorkers,
    readParseWorkers,
    '"auto" or an integer',
  );
  const parseWorkerMinBytes = readInteger(
    context,
    'parseWorkerMinBytes',
    root.parseWorkerMinBytes,
    PARSE_WORKER_MIN_BYTES_MIN,
    PARSE_WORKER_MIN_BYTES_MAX,
  );
  const update = readUpdateConfig(context, root.update);
  const machines = readMachinesConfig(context, root.machines);

  if (timezone !== undefined) {
    config.timezone = timezone;
  }

  if (logLevel !== undefined) {
    config.logLevel = logLevel;
  }

  if (monthlyBudgetUsd !== undefined) {
    config.monthlyBudgetUsd = monthlyBudgetUsd;
  }

  if (sources !== undefined) {
    config.sources = sources;
  }

  if (sourceDirs !== undefined) {
    config.sourceDirs = sourceDirs;
  }

  if (pricing !== undefined) {
    config.pricing = pricing;
  }

  if (eventStore !== undefined) {
    config.eventStore = eventStore;
  }

  if (parseMaxParallel !== undefined) {
    config.parseMaxParallel = parseMaxParallel;
  }

  if (parseWorkers !== undefined) {
    config.parseWorkers = parseWorkers;
  }

  if (parseWorkerMinBytes !== undefined) {
    config.parseWorkerMinBytes = parseWorkerMinBytes;
  }

  if (update !== undefined) {
    config.update = update;
  }

  if (machines !== undefined) {
    config.machines = machines;
  }

  return config;
}

function collectUnknownKeyWarnings(root: Record<string, unknown>): string[] {
  const unknownKeys = collectUnknownKeys(root, knownTopLevelKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'pricing', knownPricingKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'eventStore', knownEventStoreKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'update', knownUpdateKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'sourceDirs', sourceDirKeySet);

  for (const [name, machine] of Object.entries(asRecord(root.machines) ?? {})) {
    const machineRecord = asRecord(machine);

    if (machineRecord) {
      unknownKeys.push(
        ...collectUnknownKeys(machineRecord, knownMachineKeySet, `machines.${name}.`),
      );
    }
  }

  const unknownKeyWarning = formatUnknownKeyWarning(unknownKeys);
  return unknownKeyWarning === undefined ? [] : [unknownKeyWarning];
}

function parseUserConfigRoot(filePath: string, content: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = parseToml(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file ${filePath}: ${reason}`, { cause: error });
  }

  const root = asRecord(parsed);

  if (!root) {
    throw new Error(`Config file ${filePath} must contain a TOML table`);
  }

  return root;
}

export async function loadUserConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadConfigFile = readRegularTextFile,
): Promise<LoadedUserConfig> {
  const configPath = resolveUserConfigPath(env);

  let content: string;

  try {
    content = await readFile(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      if (!hasConfigPathOverride(env)) {
        await throwIfLegacyJsonConfigExists(configPath, readFile);
      }

      return {
        config: {},
        path: configPath,
        exists: false,
        warnings: [],
      };
    }

    throw error;
  }

  const root = parseUserConfigRoot(configPath, content);
  const context: ConfigReadContext = {
    configDir: path.dirname(path.resolve(configPath)),
    warnings: [],
  };
  const config = readConfig(context, root);

  return {
    config,
    path: configPath,
    exists: true,
    warnings: [...collectUnknownKeyWarnings(root), ...context.warnings],
  };
}
