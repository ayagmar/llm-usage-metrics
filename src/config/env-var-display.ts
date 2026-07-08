export type EnvVarOverride = {
  name: string;
  value: string;
  description: string;
};

const ENV_VARS_TO_DISPLAY: Array<{ name: string; description: string }> = [
  { name: 'LLM_USAGE_CONFIG_PATH', description: 'user config file path' },
  { name: 'LLM_USAGE_SKIP_UPDATE_CHECK', description: 'skip startup update check' },
  {
    name: 'LLM_USAGE_UPDATE_CACHE_SCOPE',
    description: 'update-check cache scope (global/session)',
  },
  { name: 'LLM_USAGE_UPDATE_CACHE_SESSION_KEY', description: 'update-check session cache key' },
  { name: 'LLM_USAGE_UPDATE_CACHE_TTL_MS', description: 'update-check cache TTL' },
  { name: 'LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS', description: 'update-check fetch timeout' },
  { name: 'LLM_USAGE_PRICING_CACHE_TTL_MS', description: 'pricing cache TTL' },
  { name: 'LLM_USAGE_PRICING_FETCH_TIMEOUT_MS', description: 'pricing fetch timeout' },
  { name: 'LLM_USAGE_PARSE_MAX_PARALLEL', description: 'max parallel file parsing' },
  { name: 'LLM_USAGE_PARSE_WORKERS', description: 'parse worker count' },
  { name: 'LLM_USAGE_PARSE_WORKER_MIN_BYTES', description: 'parse worker byte threshold' },
  { name: 'LLM_USAGE_EVENT_STORE', description: 'enable sqlite event store' },
  { name: 'LLM_USAGE_EVENT_STORE_PATH', description: 'sqlite event store path' },
  { name: 'LLM_USAGE_PROFILE_RUNTIME', description: 'emit runtime profiling diagnostics' },
];

export function getActiveEnvVarOverrides(): EnvVarOverride[] {
  const overrides: EnvVarOverride[] = [];

  for (const { name, description } of ENV_VARS_TO_DISPLAY) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      overrides.push({ name, value, description });
    }
  }

  return overrides;
}

export function formatEnvVarOverrides(overrides: EnvVarOverride[]): string[] {
  if (overrides.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push('Active environment overrides:');

  for (const { name, value, description } of overrides) {
    lines.push(`  ${name}=${value}  (${description})`);
  }

  return lines;
}
