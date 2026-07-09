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

function readFiles(
  files: Readonly<Record<string, string | undefined>>,
): (filePath: string) => Promise<string> {
  return async (filePath: string) => {
    const content = files[filePath];

    if (content === undefined) {
      return missingFileRead();
    }

    return content;
  };
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
    expect(resolveUserConfigPath({ LLM_USAGE_CONFIG_PATH: '/tmp/config.toml' })).toBe(
      '/tmp/config.toml',
    );
  });

  it('uses the config root default when no override is set', () => {
    const configPath = resolveUserConfigPath({
      XDG_CONFIG_HOME: '/tmp/config-home',
    });

    expect(configPath).toBe(path.join('/tmp/config-home', 'llm-usage-metrics', 'config.toml'));
  });
});

describe('loadUserConfig', () => {
  it('returns empty config when the file is absent', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/missing-config.toml',
      },
      missingFileRead,
    );

    expect(result).toEqual({
      config: {},
      path: '/tmp/missing-config.toml',
      exists: false,
      warnings: [],
    });
  });

  it('throws an actionable error for malformed TOML', async () => {
    await expect(
      loadUserConfig(
        {
          LLM_USAGE_CONFIG_PATH: '/tmp/broken-config.toml',
        },
        readContent('not == valid toml'),
      ),
    ).rejects.toThrow('Failed to parse config file /tmp/broken-config.toml:');
  });

  it('throws when the TOML document is not a table', async () => {
    await expect(
      loadUserConfig(
        {
          LLM_USAGE_CONFIG_PATH: '/tmp/array-config.toml',
        },
        readContent('[]'),
      ),
    ).rejects.toThrow('Failed to parse config file /tmp/array-config.toml:');
  });

  it('loads supported keys and reports unknown keys once', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/config.toml',
      },
      readContent(`
timezone = "Africa/Casablanca"
sources = ["codex", "claude", "codex"]
parseMaxParallel = 12
parseWorkers = "auto"
parseWorkerMinBytes = 1024
extra = true

[sourceDirs]
claude = "/tmp/claude"
unknown = "/tmp/unknown"

[pricing]
offline = true
url = "https://example.test/prices.json"
overridesPath = "/tmp/pricing.json"
ignoreFailures = false
cacheTtlMs = 30000
fetchTimeoutMs = 60000
mystery = true

[eventStore]
enabled = false
path = "/tmp/events.db"

[update]
skipCheck = true
cacheTtlMs = 2000
fetchTimeoutMs = 500
`),
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
      parseWorkers: 'auto',
      parseWorkerMinBytes: 1024,
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
        LLM_USAGE_CONFIG_PATH: '/tmp/config.toml',
      },
      readContent(`
parseMaxParallel = 100
parseWorkers = 100
parseWorkerMinBytes = -1

[pricing]
cacheTtlMs = 1
fetchTimeoutMs = 1000000

[update]
cacheTtlMs = -1
fetchTimeoutMs = 1
`),
    );

    expect(result.config).toMatchObject({
      pricing: {
        cacheTtlMs: 60_000,
        fetchTimeoutMs: 30_000,
      },
      parseMaxParallel: 64,
      parseWorkers: 64,
      parseWorkerMinBytes: 0,
      update: {
        cacheTtlMs: 0,
        fetchTimeoutMs: 200,
      },
    });
  });

  it('keeps empty and invalid typed values out of the loaded config', async () => {
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/config.toml',
      },
      readContent(`
timezone = " "
sources = []
parseWorkers = "manual"
parseWorkerMinBytes = 1.5

[pricing]
offline = "true"
cacheTtlMs = 60000.5

[eventStore]
path = ""
`),
    );

    expect(result.config).toEqual({});
  });

  it('throws an actionable error when the default legacy JSON config exists', async () => {
    const env = {
      XDG_CONFIG_HOME: '/tmp/config-home',
    };
    const tomlPath = path.join('/tmp/config-home', 'llm-usage-metrics', 'config.toml');
    const jsonPath = path.join('/tmp/config-home', 'llm-usage-metrics', 'config.json');

    await expect(
      loadUserConfig(env, readFiles({ [jsonPath]: '{"timezone":"UTC"}' })),
    ).rejects.toThrow(
      `Legacy JSON config found at ${jsonPath}. The config format is now TOML: create ${tomlPath} with the same settings (run \`llm-usage config init\` for a commented template), then remove the old file.`,
    );
  });

  it('does not probe for legacy JSON when a config path override is set', async () => {
    const readPaths: string[] = [];
    const result = await loadUserConfig(
      {
        LLM_USAGE_CONFIG_PATH: '/tmp/custom-config.toml',
      },
      async (filePath) => {
        readPaths.push(filePath);
        return missingFileRead();
      },
    );

    expect(result).toEqual({
      config: {},
      path: '/tmp/custom-config.toml',
      exists: false,
      warnings: [],
    });
    expect(readPaths).toEqual(['/tmp/custom-config.toml']);
  });

  it('uses the vitest config-path isolation default', async () => {
    const result = await loadUserConfig(process.env, missingFileRead);

    expect(result.config).toEqual({});
    expect(result.exists).toBe(false);
    expect(result.path).toBe('/tmp/llm-usage-metrics-test-missing-config.toml');
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
