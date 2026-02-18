const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const UPDATE_CACHE_TTL_DEFAULT_MS = 12 * 60 * 60 * 1000;
const UPDATE_FETCH_TIMEOUT_DEFAULT_MS = 1_000;
const PRICING_CACHE_TTL_DEFAULT_MS = DAY_MS;
const PRICING_FETCH_TIMEOUT_DEFAULT_MS = 4_000;
const PARSE_MAX_PARALLEL_DEFAULT = 8;

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

  const parsedValue = Number(trimmedValue);

  if (!Number.isFinite(parsedValue)) {
    return defaults.fallback;
  }

  const roundedValue = Math.trunc(parsedValue);

  if (roundedValue < defaults.min) {
    return defaults.min;
  }

  if (roundedValue > defaults.max) {
    return defaults.max;
  }

  return roundedValue;
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

export function getUpdateNotifierRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpdateNotifierRuntimeConfig {
  return {
    cacheTtlMs: resolveBoundedEnvInteger(env.LLM_USAGE_UPDATE_CACHE_TTL_MS, {
      fallback: UPDATE_CACHE_TTL_DEFAULT_MS,
      min: MINUTE_MS,
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
