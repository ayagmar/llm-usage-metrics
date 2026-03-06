export type EnvVarOverride = {
  name: string;
  value: string;
  description: string;
};

const ENV_VARS_TO_DISPLAY: Array<{ name: string; description: string }> = [
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
  { name: 'LLM_USAGE_PARSE_CACHE_ENABLED', description: 'enable file parse cache' },
  { name: 'LLM_USAGE_PARSE_CACHE_TTL_MS', description: 'file parse cache TTL' },
  { name: 'LLM_USAGE_PARSE_CACHE_MAX_ENTRIES', description: 'file parse cache max entries' },
  { name: 'LLM_USAGE_PARSE_CACHE_MAX_BYTES', description: 'file parse cache max bytes' },
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
