import { stat } from 'node:fs/promises';

import { createSourceContext, type SourceAdapter } from '@ayagmar/agent-sessions';
import {
  createDefaultAdapters,
  getSourceStorageFormat,
  type SourceStorageFormat,
} from '@ayagmar/agent-sessions/registry';
import { getActiveEnvVarOverrides, type EnvVarOverride } from '../config/env-var-display.js';
import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import { hasConfigPathOverride } from '../config/user-config.js';
import {
  DEFAULT_LITELLM_PRICING_URL,
  getDefaultLiteLLMPricingCachePath,
  LiteLLMPricingFetcher,
} from '../pricing/litellm-pricing-fetcher.js';
import {
  collectRuntimeConfigEntries,
  hasEnvOverride,
  resolveUserConfigForOptions,
  type UserConfigResolution,
  type UserConfigResolutionDeps,
} from './apply-user-config.js';
import {
  normalizeBuildUsageInputs,
  type NormalizedBuildUsageInputs,
  resolveCliDirectorySourceIds,
  selectAdaptersBySourceFilter,
} from './build-usage-data-inputs.js';
import { inspectEventStore, type EventStoreReadDeps } from './run-doctor-report.js';
import { createAdaptersFromOptions } from './source-cli-options.js';
import type { ConfigShowCommandOptions } from './usage-data-contracts.js';

/** Where a setting's value came from, highest layer first: flag, env var, config file, built-in. */
export type SettingOrigin = 'cli' | 'env' | 'config' | 'default';

export type ConfigSetting<Value> = { value: Value; origin: SettingOrigin };

export type ConfigReportSource = {
  id: string;
  format: SourceStorageFormat;
  origin: SettingOrigin;
  paths: { path: string; exists: boolean }[];
};

export type ConfigReportEventStoreFile =
  | { state: 'missing'; legacyPath?: string }
  | { state: 'ok'; sizeBytes: number; schemaVersion: string; eventCount: number }
  | { state: 'unsupported'; sizeBytes: number; schemaVersion?: string; error: string }
  | { state: 'error'; error: string };

/**
 * cache: the cache file (fresh, or stale with --pricing-offline). network: the next report
 * fetches the URL. bundled-snapshot: offline with no usable cache. none: offline with a
 * custom URL and no cache for it, so pricing fails.
 */
export type ConfigReportPricesFrom = 'cache' | 'network' | 'bundled-snapshot' | 'none';

export type ConfigReportData = {
  configFile: { path: string; origin: 'env' | 'default'; exists: boolean };
  sources: ConfigReportSource[];
  eventStore: {
    enabled: ConfigSetting<boolean>;
    path: ConfigSetting<string>;
    /** Absent when the store is disabled: it is not read then. */
    file?: ConfigReportEventStoreFile;
  };
  machines: { name: string; enabled: boolean }[];
  pricing: {
    url: ConfigSetting<string>;
    offline: ConfigSetting<boolean>;
    cacheTtlMs: ConfigSetting<number>;
    cache: { path: string; state: 'fresh' | 'stale' | 'none'; fetchedAt?: string };
    pricesFrom: ConfigReportPricesFrom;
    /** When the prices the next report uses were fetched; absent for network and none. */
    pricesFetchedAt?: string;
    overrides?: { path: ConfigSetting<string>; exists: boolean };
  };
  defaults: {
    timezone: ConfigSetting<string>;
    /** Empty: every source. */
    sources: ConfigSetting<string[]>;
    /** The worker count on this machine; the default `auto` is one less than the CPUs, up to 8. */
    parseWorkers: ConfigSetting<number>;
    parseMaxParallel: ConfigSetting<number>;
    parseWorkerMinBytes: ConfigSetting<number>;
    /** Departed files' usage is on by default whenever the event store is. */
    history: boolean;
  };
  environment: EnvVarOverride[];
};

export type BuildConfigReportDeps = UserConfigResolutionDeps &
  EventStoreReadDeps & {
    /** Never called: pricing loads offline. Injected by tests to prove it. */
    fetchImpl?: typeof fetch;
  };

type OriginLayers = { cli?: unknown; envVar?: string; configKey: string };

function createOriginResolver(
  userConfigResolution: UserConfigResolution,
  env: NodeJS.ProcessEnv,
): (layers: OriginLayers) => SettingOrigin {
  // The same entries the `Active config:` block lists: config values no flag or env var overrode.
  const configKeys = new Set(
    [
      ...(userConfigResolution.activeConfig?.entries ?? []),
      ...collectRuntimeConfigEntries(userConfigResolution.loadedConfig, env),
    ].map((entry) => entry.key),
  );

  return ({ cli, envVar, configKey }) => {
    if (cli !== undefined) {
      return 'cli';
    }

    if (envVar !== undefined && hasEnvOverride(env, envVar)) {
      return 'env';
    }

    return configKeys.has(configKey) ? 'config' : 'default';
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function getSearchPaths(adapter: SourceAdapter): readonly string[] {
  return adapter.getSearchPaths?.() ?? [];
}

/**
 * A source left at its default reads an env var (CODEX_HOME, XDG_DATA_HOME, ...) when its
 * default paths differ from those it resolves with an empty environment.
 */
function findEnvMovedSourceIds(sourceIds: readonly string[]): Set<string> {
  const withoutEnv = new Map(
    createDefaultAdapters({ sourceIds }, createSourceContext({ env: {} })).map((adapter) => [
      adapter.id,
      getSearchPaths(adapter).join('\n'),
    ]),
  );

  return new Set(
    createDefaultAdapters({ sourceIds })
      .filter((adapter) => getSearchPaths(adapter).join('\n') !== withoutEnv.get(adapter.id))
      .map((adapter) => adapter.id),
  );
}

async function buildSources(
  userConfigResolution: UserConfigResolution,
  resolveOrigin: (layers: OriginLayers) => SettingOrigin,
): Promise<ConfigReportSource[]> {
  const { options, cliOptions } = userConfigResolution;
  const adapters = selectAdaptersBySourceFilter(createAdaptersFromOptions(options), options.source);
  const cliSourceIds = resolveCliDirectorySourceIds(cliOptions);
  const envMovedSourceIds = findEnvMovedSourceIds(adapters.map((adapter) => adapter.id));

  return Promise.all(
    adapters.map(async (adapter) => {
      const origin = resolveOrigin({
        cli: cliSourceIds.has(adapter.id) ? true : undefined,
        configKey: `sourceDirs.${adapter.id}`,
      });

      return {
        id: adapter.id,
        format: getSourceStorageFormat(adapter.id),
        origin: origin === 'default' && envMovedSourceIds.has(adapter.id) ? 'env' : origin,
        paths: await Promise.all(
          getSearchPaths(adapter).map(async (searchPath) => ({
            path: searchPath,
            exists: await pathExists(searchPath),
          })),
        ),
      };
    }),
  );
}

function toIsoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Loads prices the way a report does but offline, so nothing is fetched or written: a fresh
 * cache, then a stale one, then the bundled snapshot. That says what the cache holds; an
 * online report replaces anything but a fresh cache with a fetch.
 */
async function inspectPricing(
  pricingUrl: string | undefined,
  offline: boolean,
  cacheTtlMs: number,
  deps: BuildConfigReportDeps,
): Promise<Pick<ConfigReportData['pricing'], 'cache' | 'pricesFrom' | 'pricesFetchedAt'>> {
  const cachePath = getDefaultLiteLLMPricingCachePath();
  const fetcher = new LiteLLMPricingFetcher({
    sourceUrl: pricingUrl,
    offline: true,
    cacheTtlMs,
    cacheFilePath: cachePath,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  try {
    await fetcher.load();
  } catch {
    return { cache: { path: cachePath, state: 'none' }, pricesFrom: offline ? 'none' : 'network' };
  }

  const origin = fetcher.getDataOrigin();
  const fetchedAt = origin ? toIsoTime(origin.fetchedAt) : undefined;

  if (origin?.kind === 'cache') {
    // The fetcher warns about a cache only when it is past its refresh interval.
    const state = fetcher.getPricingWarning() === undefined ? 'fresh' : 'stale';
    const pricesFrom = state === 'fresh' || offline ? 'cache' : 'network';

    return {
      cache: { path: cachePath, state, ...(fetchedAt ? { fetchedAt } : {}) },
      pricesFrom,
      ...(pricesFrom === 'cache' && fetchedAt ? { pricesFetchedAt: fetchedAt } : {}),
    };
  }

  return {
    cache: { path: cachePath, state: 'none' },
    pricesFrom: offline ? 'bundled-snapshot' : 'network',
    ...(offline && fetchedAt ? { pricesFetchedAt: fetchedAt } : {}),
  };
}

async function buildPricing(
  userConfigResolution: UserConfigResolution,
  pricingUrl: string | undefined,
  resolveOrigin: (layers: OriginLayers) => SettingOrigin,
  deps: BuildConfigReportDeps,
): Promise<ConfigReportData['pricing']> {
  const { options, cliOptions, loadedConfig } = userConfigResolution;
  const offline = options.pricingOffline === true;
  const { cacheTtlMs } = getPricingFetcherRuntimeConfig(loadedConfig.config);
  const overridesPath = options.pricingOverrides;

  return {
    url: {
      value: pricingUrl ?? DEFAULT_LITELLM_PRICING_URL,
      origin: resolveOrigin({ cli: cliOptions.pricingUrl, configKey: 'pricing.url' }),
    },
    offline: {
      value: offline,
      origin: resolveOrigin({ cli: cliOptions.pricingOffline, configKey: 'pricing.offline' }),
    },
    cacheTtlMs: {
      value: cacheTtlMs,
      origin: resolveOrigin({ configKey: 'pricing.cacheTtlMs' }),
    },
    ...(await inspectPricing(pricingUrl, offline, cacheTtlMs, deps)),
    ...(overridesPath === undefined
      ? {}
      : {
          overrides: {
            path: {
              value: overridesPath,
              origin: resolveOrigin({
                cli: cliOptions.pricingOverrides,
                configKey: 'pricing.overridesPath',
              }),
            },
            exists: await pathExists(overridesPath),
          },
        }),
  };
}

async function buildEventStore(
  userConfigResolution: UserConfigResolution,
  resolveOrigin: (layers: OriginLayers) => SettingOrigin,
  env: NodeJS.ProcessEnv,
  deps: BuildConfigReportDeps,
): Promise<ConfigReportData['eventStore']> {
  const runtimeConfig = getEventStoreRuntimeConfig(env, userConfigResolution.loadedConfig.config);

  return {
    enabled: {
      value: runtimeConfig.enabled,
      origin: resolveOrigin({ envVar: 'LLM_USAGE_EVENT_STORE', configKey: 'eventStore.enabled' }),
    },
    path: {
      value: runtimeConfig.path,
      origin: resolveOrigin({ envVar: 'LLM_USAGE_EVENT_STORE_PATH', configKey: 'eventStore.path' }),
    },
    ...(runtimeConfig.enabled ? { file: await inspectEventStore(runtimeConfig.path, deps) } : {}),
  };
}

function buildDefaults(
  userConfigResolution: UserConfigResolution,
  inputs: Pick<NormalizedBuildUsageInputs, 'timezone' | 'sourceFilter'>,
  resolveOrigin: (layers: OriginLayers) => SettingOrigin,
  env: NodeJS.ProcessEnv,
  historyEnabled: boolean,
): ConfigReportData['defaults'] {
  const { cliOptions, loadedConfig } = userConfigResolution;
  const parsing = getParsingRuntimeConfig(env, loadedConfig.config);

  return {
    timezone: {
      value: inputs.timezone,
      origin: resolveOrigin({ cli: cliOptions.timezone, configKey: 'timezone' }),
    },
    sources: {
      value: [...(inputs.sourceFilter ?? [])],
      origin: resolveOrigin({ cli: cliOptions.source, configKey: 'sources' }),
    },
    parseWorkers: {
      value: parsing.parseWorkers,
      origin: resolveOrigin({ envVar: 'LLM_USAGE_PARSE_WORKERS', configKey: 'parseWorkers' }),
    },
    parseMaxParallel: {
      value: parsing.maxParallelFileParsing,
      origin: resolveOrigin({ configKey: 'parseMaxParallel' }),
    },
    parseWorkerMinBytes: {
      value: parsing.parseWorkerMinBytes,
      origin: resolveOrigin({
        envVar: 'LLM_USAGE_PARSE_WORKER_MIN_BYTES',
        configKey: 'parseWorkerMinBytes',
      }),
    },
    history: historyEnabled,
  };
}

/**
 * The effective setup, from the config file, env vars and flags, read without side effects:
 * paths are only `stat`ed, the event store is opened read-only, prices load offline, and
 * machines are listed from the config without contacting them.
 */
export async function buildConfigReport(
  options: ConfigShowCommandOptions,
  deps: BuildConfigReportDeps = {},
): Promise<{ data: ConfigReportData; warnings: string[] }> {
  const env = process.env;
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const { loadedConfig } = userConfigResolution;
  // Validates --timezone and --pricing-url the way reports do, before anything is read.
  const inputs = normalizeBuildUsageInputs(
    userConfigResolution.options,
    userConfigResolution.cliOptions,
  );
  const resolveOrigin = createOriginResolver(userConfigResolution, env);
  const eventStore = await buildEventStore(userConfigResolution, resolveOrigin, env, deps);

  return {
    data: {
      configFile: {
        path: loadedConfig.path,
        origin: hasConfigPathOverride(env) ? 'env' : 'default',
        exists: loadedConfig.exists,
      },
      sources: await buildSources(userConfigResolution, resolveOrigin),
      eventStore,
      machines: Object.entries(loadedConfig.config.machines ?? {}).map(([name, machine]) => ({
        name,
        enabled: machine.enabled !== false,
      })),
      pricing: await buildPricing(userConfigResolution, inputs.pricingUrl, resolveOrigin, deps),
      defaults: buildDefaults(
        userConfigResolution,
        inputs,
        resolveOrigin,
        env,
        eventStore.enabled.value,
      ),
      environment: getActiveEnvVarOverrides(),
    },
    warnings: loadedConfig.warnings,
  };
}
