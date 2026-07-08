import type { ActiveConfig, ActiveConfigEntry } from '../config/active-config-display.js';
import type { LoadedUserConfig, UserConfig } from '../config/user-config.js';
import { loadUserConfig } from '../config/user-config.js';
import type { ReportCommandOptions } from './usage-data-contracts.js';

const sourceDirOptionByConfigKey = {
  pi: 'piDir',
  codex: 'codexDir',
  copilot: 'copilotDir',
  gemini: 'geminiDir',
  droid: 'droidDir',
  claude: 'claudeDir',
  openclaw: 'openclawDir',
  opencode: 'opencodeDb',
  goose: 'gooseDb',
  amp: 'ampDir',
  qwen: 'qwenDir',
  kimi: 'kimiDir',
  cline: 'clineDir',
  roocode: 'roocodeDir',
  kilocode: 'kilocodeDir',
  antigravity: 'antigravityDir',
} as const satisfies Record<string, keyof ReportCommandOptions>;

type SourceDirConfigKey = keyof typeof sourceDirOptionByConfigKey;
type SourceDirOptionKey = (typeof sourceDirOptionByConfigKey)[SourceDirConfigKey];

const sourceDirConfigKeys = [
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
] as const satisfies readonly SourceDirConfigKey[];

export type UserConfigResolution = {
  loadedConfig: LoadedUserConfig;
  options: ReportCommandOptions;
  activeConfig: ActiveConfig | undefined;
};

export type UserConfigResolutionDeps = {
  loadUserConfig?: () => Promise<LoadedUserConfig>;
  userConfigResolution?: UserConfigResolution;
};

function formatConfigValue(value: boolean | number | string | readonly string[]): string {
  if (Array.isArray(value)) {
    return value.join(',');
  }

  return String(value);
}

function applyOptionValue<Key extends keyof ReportCommandOptions>(
  output: ReportCommandOptions,
  original: ReportCommandOptions,
  entries: ActiveConfigEntry[],
  optionKey: Key,
  configKey: string,
  value: NonNullable<ReportCommandOptions[Key]>,
): void {
  if (original[optionKey] !== undefined) {
    return;
  }

  output[optionKey] = value;
  entries.push({ key: configKey, value: formatConfigValue(value) });
}

function applySourceDirs(
  output: ReportCommandOptions,
  original: ReportCommandOptions,
  entries: ActiveConfigEntry[],
  sourceDirs: UserConfig['sourceDirs'],
): void {
  if (!sourceDirs) {
    return;
  }

  for (const sourceId of sourceDirConfigKeys) {
    const optionKey: SourceDirOptionKey = sourceDirOptionByConfigKey[sourceId];
    const sourceDir = sourceDirs[sourceId];

    if (sourceDir === undefined || original[optionKey] !== undefined) {
      continue;
    }

    Object.assign(output, { [optionKey]: sourceDir });
    entries.push({ key: `sourceDirs.${sourceId}`, value: sourceDir });
  }
}

function buildActiveConfig(
  loadedConfig: LoadedUserConfig,
  entries: ActiveConfigEntry[],
): ActiveConfig | undefined {
  if (!loadedConfig.exists || entries.length === 0) {
    return undefined;
  }

  return {
    path: loadedConfig.path,
    entries,
  };
}

function hasEnvOverride(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== '';
}

function pushRuntimeEntry(
  entries: ActiveConfigEntry[],
  env: NodeJS.ProcessEnv,
  envName: string,
  key: string,
  value: boolean | number | string | undefined,
): void {
  if (value === undefined || hasEnvOverride(env, envName)) {
    return;
  }

  entries.push({ key, value: formatConfigValue(value) });
}

export function collectRuntimeConfigEntries(
  loadedConfig: LoadedUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): ActiveConfigEntry[] {
  if (!loadedConfig.exists) {
    return [];
  }

  const config = loadedConfig.config;
  const entries: ActiveConfigEntry[] = [];

  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_PRICING_CACHE_TTL_MS',
    'pricing.cacheTtlMs',
    config.pricing?.cacheTtlMs,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_PRICING_FETCH_TIMEOUT_MS',
    'pricing.fetchTimeoutMs',
    config.pricing?.fetchTimeoutMs,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_EVENT_STORE',
    'eventStore.enabled',
    config.eventStore?.enabled,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_EVENT_STORE_PATH',
    'eventStore.path',
    config.eventStore?.path,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_PARSE_MAX_PARALLEL',
    'parseMaxParallel',
    config.parseMaxParallel,
  );
  pushRuntimeEntry(entries, env, 'LLM_USAGE_PARSE_WORKERS', 'parseWorkers', config.parseWorkers);
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_PARSE_WORKER_MIN_BYTES',
    'parseWorkerMinBytes',
    config.parseWorkerMinBytes,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_SKIP_UPDATE_CHECK',
    'update.skipCheck',
    config.update?.skipCheck,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_UPDATE_CACHE_TTL_MS',
    'update.cacheTtlMs',
    config.update?.cacheTtlMs,
  );
  pushRuntimeEntry(
    entries,
    env,
    'LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS',
    'update.fetchTimeoutMs',
    config.update?.fetchTimeoutMs,
  );

  return entries;
}

export function mergeActiveConfigEntries(
  loadedConfig: LoadedUserConfig,
  entries: ActiveConfigEntry[],
): ActiveConfig | undefined {
  return buildActiveConfig(loadedConfig, entries);
}

export function applyUserConfigToReportOptions(
  options: ReportCommandOptions,
  loadedConfig: LoadedUserConfig,
): UserConfigResolution {
  const config = loadedConfig.config;
  const output: ReportCommandOptions = { ...options };
  const entries: ActiveConfigEntry[] = [];

  if (config.timezone !== undefined) {
    applyOptionValue(output, options, entries, 'timezone', 'timezone', config.timezone);
  }

  if (config.sources !== undefined) {
    applyOptionValue(output, options, entries, 'source', 'sources', config.sources);
  }

  applySourceDirs(output, options, entries, config.sourceDirs);

  if (config.pricing?.offline !== undefined) {
    applyOptionValue(
      output,
      options,
      entries,
      'pricingOffline',
      'pricing.offline',
      config.pricing.offline,
    );
  }

  if (config.pricing?.url !== undefined) {
    applyOptionValue(output, options, entries, 'pricingUrl', 'pricing.url', config.pricing.url);
  }

  if (config.pricing?.overridesPath !== undefined) {
    applyOptionValue(
      output,
      options,
      entries,
      'pricingOverrides',
      'pricing.overridesPath',
      config.pricing.overridesPath,
    );
  }

  if (config.pricing?.ignoreFailures !== undefined) {
    applyOptionValue(
      output,
      options,
      entries,
      'ignorePricingFailures',
      'pricing.ignoreFailures',
      config.pricing.ignoreFailures,
    );
  }

  return {
    loadedConfig,
    options: output,
    activeConfig: buildActiveConfig(loadedConfig, entries),
  };
}

export async function resolveUserConfigForOptions(
  options: ReportCommandOptions,
  deps: UserConfigResolutionDeps = {},
): Promise<UserConfigResolution> {
  if (deps.userConfigResolution) {
    return deps.userConfigResolution;
  }

  const loadedConfig = deps.loadUserConfig ? await deps.loadUserConfig() : await loadUserConfig();
  return applyUserConfigToReportOptions(options, loadedConfig);
}
