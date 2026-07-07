import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadUserConfig,
  resolveUserConfigPath,
  USER_CONFIG_KNOWN_KEY_PATHS,
} from '../../src/config/user-config.js';

function missingFileRead(): Promise<string> {
  return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
}

function readContent(content: string): () => Promise<string> {
  return async () => content;
}

function collectSchemaKeyPaths(schema: Record<string, unknown>): string[] {
  const rootProperties = schema.properties;

  if (!rootProperties || typeof rootProperties !== 'object' || Array.isArray(rootProperties)) {
    throw new Error('schema properties must be an object');
  }

  const keyPaths: string[] = [];

  for (const [key, value] of Object.entries(rootProperties)) {
    keyPaths.push(key);

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const nestedProperties = (value as { properties?: unknown }).properties;

    if (
      !nestedProperties ||
      typeof nestedProperties !== 'object' ||
      Array.isArray(nestedProperties)
    ) {
      continue;
    }

    for (const nestedKey of Object.keys(nestedProperties)) {
      keyPaths.push(`${key}.${nestedKey}`);
    }
  }

  return keyPaths.sort();
}

describe('resolveUserConfigPath', () => {
  it('uses LLM_USAGE_CONFIG_PATH when set', () => {
    expect(resolveUserConfigPath({ LLM_USAGE_CONFIG_PATH: '/tmp/config.json' })).toBe(
      '/tmp/config.json',
    );
  });

  it('uses the config root default when no override is set', () => {
    const configPath = resolveUserConfigPath({
      XDG_CONFIG_HOME: '/tmp/config-home',
    });

    expect(configPath).toBe(path.join('/tmp/config-home', 'llm-usage-metrics', 'config.json'));
  });
});

describe('loadUserConfig', () => {
  it('returns empty config when the file is absent', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/missing-config.json',
      },
      missingFileRead,
    );

    expect(result).toEqual({
      config: {},
      path: '/tmp/missing-config.json',
      exists: false,
      warnings: [],
    });
  });

  it('throws an actionable error for malformed JSON', async () => {
    await expect(
      loadUserConfig(
        {
          LLM_USAGE_CONFIG_PATH: '/tmp/broken-config.json',
        },
        readContent('{'),
      ),
    ).rejects.toThrow('Failed to parse config file /tmp/broken-config.json:');
  });

  it('throws when the config root is not a JSON object', async () => {
    await expect(
      loadUserConfig(
        {
          LLM_USAGE_CONFIG_PATH: '/tmp/array-config.json',
        },
        readContent('[]'),
      ),
    ).rejects.toThrow('Config file /tmp/array-config.json must contain a JSON object');
  });

  it('loads supported keys and reports unknown keys once', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/config.json',
      },
      readContent(
        JSON.stringify({
          $schema: 'https://ayagmar.github.io/llm-usage-metrics/config-schema.json',
          timezone: 'Africa/Casablanca',
          sources: ['codex', 'claude', 'codex'],
          sourceDirs: {
            claude: '/tmp/claude',
            unknown: '/tmp/unknown',
          },
          pricing: {
            offline: true,
            url: 'https://example.test/prices.json',
            overridesPath: '/tmp/pricing.json',
            ignoreFailures: false,
            cacheTtlMs: 30_000,
            fetchTimeoutMs: 60_000,
            mystery: true,
          },
          eventStore: {
            enabled: false,
            path: '/tmp/events.db',
          },
          parseMaxParallel: 12,
          update: {
            skipCheck: true,
            cacheTtlMs: 2_000,
            fetchTimeoutMs: 500,
          },
          extra: true,
        }),
      ),
    );

    expect(result.exists).toBe(true);
    expect(result.config).toEqual({
      timezone: 'Africa/Casablanca',
      sources: ['codex', 'claude'],
      sourceDirs: {
        claude: '/tmp/claude',
      },
      pricing: {
        offline: true,
        url: 'https://example.test/prices.json',
        overridesPath: '/tmp/pricing.json',
        ignoreFailures: false,
        cacheTtlMs: 60_000,
        fetchTimeoutMs: 30_000,
      },
      eventStore: {
        enabled: false,
        path: '/tmp/events.db',
      },
      parseMaxParallel: 12,
      update: {
        skipCheck: true,
        cacheTtlMs: 2_000,
        fetchTimeoutMs: 500,
      },
    });
    expect(result.warnings).toEqual([
      'Unknown config key(s): extra, pricing.mystery, sourceDirs.unknown',
    ]);
  });

  it('clamps numeric config values to existing runtime bounds', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/config.json',
      },
      readContent(
        JSON.stringify({
          pricing: {
            cacheTtlMs: 1,
            fetchTimeoutMs: 1_000_000,
          },
          parseMaxParallel: 100,
          update: {
            cacheTtlMs: -1,
            fetchTimeoutMs: 1,
          },
        }),
      ),
    );

    expect(result.config).toMatchObject({
      pricing: {
        cacheTtlMs: 60_000,
        fetchTimeoutMs: 30_000,
      },
      parseMaxParallel: 64,
      update: {
        cacheTtlMs: 0,
        fetchTimeoutMs: 200,
      },
    });
  });

  it('keeps empty and invalid typed values out of the loaded config', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/config.json',
      },
      readContent(
        JSON.stringify({
          timezone: ' ',
          sources: [],
          pricing: {
            offline: 'true',
            cacheTtlMs: 60_000.5,
          },
          eventStore: {
            path: '',
          },
        }),
      ),
    );

    expect(result.config).toEqual({});
  });
});

describe('config schema', () => {
  it('matches the loader known key set', async () => {
    const schemaText = await readFile('schema/config.schema.json', 'utf8');
    const schema = JSON.parse(schemaText) as Record<string, unknown>;

    expect(collectSchemaKeyPaths(schema)).toEqual([...USER_CONFIG_KNOWN_KEY_PATHS].sort());
  });

  it('publishes the same schema under site/public', async () => {
    await expect(readFile('site/public/config-schema.json', 'utf8')).resolves.toBe(
      await readFile('schema/config.schema.json', 'utf8'),
    );
  });
});
