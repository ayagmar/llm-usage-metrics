import { describe, expect, it } from 'vitest';

import {
  applyUserConfigToReportOptions,
  collectRuntimeConfigEntries,
} from '../../src/cli/apply-user-config.js';
import type { LoadedUserConfig } from '../../src/config/user-config.js';
import { formatActiveConfig } from '../../src/config/active-config-display.js';

function createLoadedConfig(config: LoadedUserConfig['config']): LoadedUserConfig {
  return {
    config,
    path: '/tmp/config.toml',
    exists: true,
    warnings: [],
  };
}

describe('applyUserConfigToReportOptions', () => {
  it('applies config below flags for boolean and string options', () => {
    const loadedConfig = createLoadedConfig({
      pricing: {
        offline: true,
        url: 'https://config.example/pricing.json',
      },
    });

    const configured = applyUserConfigToReportOptions(
      {
        pricingOffline: false,
        pricingUrl: 'https://flag.example/pricing.json',
      },
      loadedConfig,
    );
    const defaulted = applyUserConfigToReportOptions({}, loadedConfig);

    expect(configured.options).toMatchObject({
      pricingOffline: false,
      pricingUrl: 'https://flag.example/pricing.json',
    });
    expect(configured.activeConfig).toBeUndefined();
    expect(defaulted.options).toMatchObject({
      pricingOffline: true,
      pricingUrl: 'https://config.example/pricing.json',
    });
    expect(defaulted.activeConfig?.entries).toEqual([
      { key: 'pricing.offline', value: 'true' },
      { key: 'pricing.url', value: 'https://config.example/pricing.json' },
    ]);
  });

  it('applies config below flags for source arrays and source dirs', () => {
    const loadedConfig = createLoadedConfig({
      sources: ['codex', 'claude'],
      sourceDirs: {
        claude: '/tmp/config-claude',
      },
    });

    const configured = applyUserConfigToReportOptions(
      {
        source: ['pi'],
        claudeDir: '/tmp/flag-claude',
      },
      loadedConfig,
    );
    const defaulted = applyUserConfigToReportOptions({}, loadedConfig);

    expect(configured.options).toMatchObject({
      source: ['pi'],
      claudeDir: '/tmp/flag-claude',
    });
    expect(configured.activeConfig).toBeUndefined();
    expect(defaulted.options).toMatchObject({
      source: ['codex', 'claude'],
      claudeDir: '/tmp/config-claude',
    });
    expect(defaulted.activeConfig?.entries).toEqual([
      { key: 'sources', value: 'codex,claude' },
      { key: 'sourceDirs.claude', value: '/tmp/config-claude' },
    ]);
  });

  it('omits active runtime config entries shadowed by env vars', () => {
    const loadedConfig = createLoadedConfig({
      pricing: {
        cacheTtlMs: 60_000,
        fetchTimeoutMs: 5_000,
      },
      eventStore: {
        enabled: true,
        path: '/tmp/config-events.db',
      },
      parseMaxParallel: 12,
      parseWorkers: 4,
      parseWorkerMinBytes: 1024,
    });

    expect(
      collectRuntimeConfigEntries(loadedConfig, {
        LLM_USAGE_PRICING_CACHE_TTL_MS: '1800000',
        LLM_USAGE_EVENT_STORE_PATH: '/tmp/env-events.db',
        LLM_USAGE_PARSE_WORKERS: '2',
      }),
    ).toEqual([
      { key: 'pricing.fetchTimeoutMs', value: '5000' },
      { key: 'eventStore.enabled', value: 'true' },
      { key: 'parseMaxParallel', value: '12' },
      { key: 'parseWorkerMinBytes', value: '1024' },
    ]);
  });

  it('formats active config for stderr diagnostics', () => {
    expect(
      formatActiveConfig({
        path: '/tmp/config.toml',
        entries: [
          { key: 'sources', value: 'codex,claude' },
          { key: 'pricing.offline', value: 'true' },
        ],
      }),
    ).toEqual([
      'Active config: /tmp/config.toml',
      '  sources=codex,claude',
      '  pricing.offline=true',
    ]);
  });
});
