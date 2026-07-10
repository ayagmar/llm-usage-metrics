import { availableParallelism } from 'node:os';

import { getDefaultEventStorePath } from '../persistence/event-store.js';
import type { UserConfig } from './user-config.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * 60 * 1000;

export const UPDATE_CACHE_TTL_DEFAULT_MS = HOUR_MS;
export const UPDATE_FETCH_TIMEOUT_DEFAULT_MS = 1_000;
export const PRICING_CACHE_TTL_DEFAULT_MS = DAY_MS;
export const PRICING_FETCH_TIMEOUT_DEFAULT_MS = 4_000;
export const PARSE_MAX_PARALLEL_DEFAULT = 8;
export const PARSE_WORKERS_CONFIG_DEFAULT = 'auto';
const PARSE_WORKER_MAX = 64;
export const PARSE_WORKER_MIN_BYTES_DEFAULT = 268_435_456;
export const EVENT_STORE_ENABLED_DEFAULT = true;

function resolveBoundedInteger(
  envValue: string | undefined,
  configValue: number | undefined,
  defaults: {
    fallback: number;
    min: number;
    max: number;
  },
): number {
  const fallback = configValue ?? defaults.fallback;

  if (envValue === undefined) {
    return fallback;
  }

  const trimmedValue = envValue.trim();

  if (trimmedValue.length === 0) {
    return fallback;
  }

  if (!/^[+-]?\d+$/u.test(trimmedValue)) {
    return fallback;
  }

  const parsedValue = Number.parseInt(trimmedValue, 10);

  if (parsedValue < defaults.min) {
    return defaults.min;
  }

  if (parsedValue > defaults.max) {
    return defaults.max;
  }

  return parsedValue;
}

function resolveBoolean(envValue: string | undefined, fallback: boolean): boolean {
  if (envValue === undefined) {
    return fallback;
  }

  const normalizedValue = envValue.trim().toLowerCase();

  if (normalizedValue.length === 0) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  return fallback;
}

export type UpdateNotifierRuntimeConfig = {
  skipCheck: boolean;
  cacheTtlMs: number;
  fetchTimeoutMs: number;
};

export type PricingFetcherRuntimeConfig = {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
};

export type ParsingRuntimeConfig = {
  maxParallelFileParsing: number;
  parseWorkers: number;
  parseWorkerMinBytes: number;
};

export type EventStoreRuntimeConfig = {
  enabled: boolean;
  path: string;
};

export function getUpdateNotifierRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  config: UserConfig = {},
): UpdateNotifierRuntimeConfig {
  return {
    skipCheck: resolveBoolean(env.LLM_USAGE_SKIP_UPDATE_CHECK, config.update?.skipCheck ?? false),
    cacheTtlMs: resolveBoundedInteger(undefined, config.update?.cacheTtlMs, {
      fallback: UPDATE_CACHE_TTL_DEFAULT_MS,
      min: 0,
      max: 30 * DAY_MS,
    }),
    fetchTimeoutMs: resolveBoundedInteger(undefined, config.update?.fetchTimeoutMs, {
      fallback: UPDATE_FETCH_TIMEOUT_DEFAULT_MS,
      min: 200,
      max: 30_000,
    }),
  };
}

export function getPricingFetcherRuntimeConfig(
  config: UserConfig = {},
): PricingFetcherRuntimeConfig {
  return {
    cacheTtlMs: resolveBoundedInteger(undefined, config.pricing?.cacheTtlMs, {
      fallback: PRICING_CACHE_TTL_DEFAULT_MS,
      min: MINUTE_MS,
      max: 30 * DAY_MS,
    }),
    fetchTimeoutMs: resolveBoundedInteger(undefined, config.pricing?.fetchTimeoutMs, {
      fallback: PRICING_FETCH_TIMEOUT_DEFAULT_MS,
      min: 200,
      max: 30_000,
    }),
  };
}

function getAutoParseWorkerCount(): number {
  return Math.max(0, Math.min(8, availableParallelism() - 1));
}

function resolveParseWorkers(
  envValue: string | undefined,
  configValue: UserConfig['parseWorkers'],
): number {
  if (envValue === undefined || envValue.trim().length === 0) {
    return configValue === undefined || configValue === 'auto'
      ? getAutoParseWorkerCount()
      : configValue;
  }

  const trimmedValue = envValue.trim().toLowerCase();

  if (trimmedValue === 'auto') {
    return getAutoParseWorkerCount();
  }

  return resolveBoundedInteger(envValue, configValue === 'auto' ? undefined : configValue, {
    fallback: getAutoParseWorkerCount(),
    min: 0,
    max: PARSE_WORKER_MAX,
  });
}

export function getParsingRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  config: UserConfig = {},
): ParsingRuntimeConfig {
  return {
    maxParallelFileParsing: resolveBoundedInteger(undefined, config.parseMaxParallel, {
      fallback: PARSE_MAX_PARALLEL_DEFAULT,
      min: 1,
      max: 64,
    }),
    parseWorkers: resolveParseWorkers(env.LLM_USAGE_PARSE_WORKERS, config.parseWorkers),
    parseWorkerMinBytes: resolveBoundedInteger(
      env.LLM_USAGE_PARSE_WORKER_MIN_BYTES,
      config.parseWorkerMinBytes,
      {
        fallback: PARSE_WORKER_MIN_BYTES_DEFAULT,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      },
    ),
  };
}

export function getEventStoreRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  config: UserConfig = {},
): EventStoreRuntimeConfig {
  const eventStorePathOverride = env.LLM_USAGE_EVENT_STORE_PATH?.trim();
  const eventStorePath =
    eventStorePathOverride === undefined || eventStorePathOverride.length === 0
      ? (config.eventStore?.path ?? getDefaultEventStorePath())
      : eventStorePathOverride;

  return {
    enabled: resolveBoolean(
      env.LLM_USAGE_EVENT_STORE,
      config.eventStore?.enabled ?? EVENT_STORE_ENABLED_DEFAULT,
    ),
    path: eventStorePath,
  };
}
