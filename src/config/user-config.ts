import { readFile as readFileFromFs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { asRecord } from '../utils/as-record.js';
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
] as const;

const knownTopLevelKeys = [
  'eventStore',
  'logLevel',
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

export const USER_CONFIG_KNOWN_KEY_PATHS = [
  ...knownTopLevelKeys,
  ...knownPricingKeys.map((key) => `pricing.${key}`),
  ...knownEventStoreKeys.map((key) => `eventStore.${key}`),
  ...knownUpdateKeys.map((key) => `update.${key}`),
  ...USER_CONFIG_SOURCE_DIR_KEYS.map((key) => `sourceDirs.${key}`),
] as const;

const knownTopLevelKeySet = new Set<string>(knownTopLevelKeys);
const knownPricingKeySet = new Set<string>(knownPricingKeys);
const knownEventStoreKeySet = new Set<string>(knownEventStoreKeys);
const knownUpdateKeySet = new Set<string>(knownUpdateKeys);
const sourceDirKeySet = new Set<string>(USER_CONFIG_SOURCE_DIR_KEYS);

export type UserConfig = {
  timezone?: string;
  logLevel?: LogLevel;
  sources?: string[];
  sourceDirs?: Partial<Record<(typeof USER_CONFIG_SOURCE_DIR_KEYS)[number], string>>;
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

function toNonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length === 0 ? undefined : trimmedValue;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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

function readSourceDirs(value: unknown): UserConfig['sourceDirs'] | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const sourceDirs: UserConfig['sourceDirs'] = {};

  for (const sourceId of USER_CONFIG_SOURCE_DIR_KEYS) {
    const sourceDir = toNonBlankString(record[sourceId]);

    if (sourceDir !== undefined) {
      sourceDirs[sourceId] = sourceDir;
    }
  }

  return Object.keys(sourceDirs).length === 0 ? undefined : sourceDirs;
}

function readPricingConfig(value: unknown): UserConfig['pricing'] | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const pricing: UserConfig['pricing'] = {};
  const offline = toBoolean(record.offline);
  const url = toNonBlankString(record.url);
  const overridesPath = toNonBlankString(record.overridesPath);
  const ignoreFailures = toBoolean(record.ignoreFailures);
  const cacheTtlMs = clampInteger(
    record.cacheTtlMs,
    PRICING_CACHE_TTL_MIN_MS,
    PRICING_CACHE_TTL_MAX_MS,
  );
  const fetchTimeoutMs = clampInteger(
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

function readEventStoreConfig(value: unknown): UserConfig['eventStore'] | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const eventStore: UserConfig['eventStore'] = {};
  const enabled = toBoolean(record.enabled);
  const pathValue = toNonBlankString(record.path);

  if (enabled !== undefined) {
    eventStore.enabled = enabled;
  }

  if (pathValue !== undefined) {
    eventStore.path = pathValue;
  }

  return Object.keys(eventStore).length === 0 ? undefined : eventStore;
}

function readUpdateConfig(value: unknown): UserConfig['update'] | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const update: UserConfig['update'] = {};
  const skipCheck = toBoolean(record.skipCheck);
  const cacheTtlMs = clampInteger(
    record.cacheTtlMs,
    UPDATE_CACHE_TTL_MIN_MS,
    UPDATE_CACHE_TTL_MAX_MS,
  );
  const fetchTimeoutMs = clampInteger(
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

function readParseWorkers(value: unknown): UserConfig['parseWorkers'] | undefined {
  if (value === 'auto') {
    return 'auto';
  }

  return clampInteger(value, PARSE_WORKERS_MIN, PARSE_WORKERS_MAX);
}

function readConfig(root: Record<string, unknown>): UserConfig {
  const config: UserConfig = {};
  const timezone = toNonBlankString(root.timezone);
  const logLevel = readLogLevel(root.logLevel);
  const sources = toSources(root.sources);
  const sourceDirs = readSourceDirs(root.sourceDirs);
  const pricing = readPricingConfig(root.pricing);
  const eventStore = readEventStoreConfig(root.eventStore);
  const parseMaxParallel = clampInteger(
    root.parseMaxParallel,
    PARSE_MAX_PARALLEL_MIN,
    PARSE_MAX_PARALLEL_MAX,
  );
  const parseWorkers = readParseWorkers(root.parseWorkers);
  const parseWorkerMinBytes = clampInteger(
    root.parseWorkerMinBytes,
    PARSE_WORKER_MIN_BYTES_MIN,
    PARSE_WORKER_MIN_BYTES_MAX,
  );
  const update = readUpdateConfig(root.update);

  if (timezone !== undefined) {
    config.timezone = timezone;
  }

  if (logLevel !== undefined) {
    config.logLevel = logLevel;
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

  return config;
}

function collectUserConfigWarnings(root: Record<string, unknown>): string[] {
  const unknownKeys = collectUnknownKeys(root, knownTopLevelKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'pricing', knownPricingKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'eventStore', knownEventStoreKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'update', knownUpdateKeySet);
  pushUnknownNestedKeys(unknownKeys, root, 'sourceDirs', sourceDirKeySet);

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
  readFile: ReadConfigFile = (filePath) => readFileFromFs(filePath, 'utf8'),
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

  return {
    config: readConfig(root),
    path: configPath,
    exists: true,
    warnings: collectUserConfigWarnings(root),
  };
}
