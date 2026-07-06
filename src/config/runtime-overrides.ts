import { getDefaultEventStorePath } from '../persistence/event-store.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * 60 * 1000;

const UPDATE_CACHE_TTL_DEFAULT_MS = HOUR_MS;
const UPDATE_FETCH_TIMEOUT_DEFAULT_MS = 1_000;
const PRICING_CACHE_TTL_DEFAULT_MS = DAY_MS;
const PRICING_FETCH_TIMEOUT_DEFAULT_MS = 4_000;
const PARSE_MAX_PARALLEL_DEFAULT = 8;
const EVENT_STORE_ENABLED_DEFAULT = true;

function resolveBoundedEnvInteger(
  envValue: string | undefined,
  defaults: {
    fallback: number;
    min: number;
    max: number;
  },
): number {
  if (envValue === undefined) {
    return defaults.fallback;
  }

  const trimmedValue = envValue.trim();

  if (trimmedValue.length === 0) {
    return defaults.fallback;
  }

  if (!/^[+-]?\d+$/u.test(trimmedValue)) {
    return defaults.fallback;
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

function resolveEnvBoolean(envValue: string | undefined, fallback: boolean): boolean {
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
  cacheTtlMs: number;
  fetchTimeoutMs: number;
};

export type PricingFetcherRuntimeConfig = {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
};

export type ParsingRuntimeConfig = {
  maxParallelFileParsing: number;
};

export type EventStoreRuntimeConfig = {
  enabled: boolean;
  path: string;
};

export function getUpdateNotifierRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpdateNotifierRuntimeConfig {
  return {
    cacheTtlMs: resolveBoundedEnvInteger(env.LLM_USAGE_UPDATE_CACHE_TTL_MS, {
      fallback: UPDATE_CACHE_TTL_DEFAULT_MS,
      min: 0,
      max: 30 * DAY_MS,
    }),
    fetchTimeoutMs: resolveBoundedEnvInteger(env.LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS, {
      fallback: UPDATE_FETCH_TIMEOUT_DEFAULT_MS,
      min: 200,
      max: 30_000,
    }),
  };
}

export function getPricingFetcherRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PricingFetcherRuntimeConfig {
  return {
    cacheTtlMs: resolveBoundedEnvInteger(env.LLM_USAGE_PRICING_CACHE_TTL_MS, {
      fallback: PRICING_CACHE_TTL_DEFAULT_MS,
      min: MINUTE_MS,
      max: 30 * DAY_MS,
    }),
    fetchTimeoutMs: resolveBoundedEnvInteger(env.LLM_USAGE_PRICING_FETCH_TIMEOUT_MS, {
      fallback: PRICING_FETCH_TIMEOUT_DEFAULT_MS,
      min: 200,
      max: 30_000,
    }),
  };
}

export function getParsingRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ParsingRuntimeConfig {
  return {
    maxParallelFileParsing: resolveBoundedEnvInteger(env.LLM_USAGE_PARSE_MAX_PARALLEL, {
      fallback: PARSE_MAX_PARALLEL_DEFAULT,
      min: 1,
      max: 64,
    }),
  };
}

export function getEventStoreRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): EventStoreRuntimeConfig {
  const eventStorePathOverride = env.LLM_USAGE_EVENT_STORE_PATH?.trim();
  const eventStorePath =
    eventStorePathOverride === undefined || eventStorePathOverride.length === 0
      ? getDefaultEventStorePath()
      : eventStorePathOverride;

  return {
    enabled: resolveEnvBoolean(env.LLM_USAGE_EVENT_STORE, EVENT_STORE_ENABLED_DEFAULT),
    path: eventStorePath,
  };
}
