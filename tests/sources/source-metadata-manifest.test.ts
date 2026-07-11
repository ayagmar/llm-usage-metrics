import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { applyUserConfigToReportOptions } from '../../src/cli/apply-user-config.js';
import type { ReportCommandOptions } from '../../src/cli/usage-data-contracts.js';
import {
  USER_CONFIG_KNOWN_KEY_PATHS,
  USER_CONFIG_SOURCE_DIR_KEYS,
} from '../../src/config/user-config.js';
import type { LoadedUserConfig } from '../../src/config/user-config.js';
import {
  getDefaultSourceIds,
  getSourceOverrideOptions,
} from '../../src/sources/create-default-adapters.js';

const EXPECTED_OVERRIDE_OPTIONS = [
  { id: 'pi', optionKey: 'piDir', flag: '--pi-dir <path>', help: 'Path to .pi sessions directory' },
  {
    id: 'codex',
    optionKey: 'codexDir',
    flag: '--codex-dir <path>',
    help: 'Path to .codex sessions directory',
  },
  {
    id: 'copilot',
    optionKey: 'copilotDir',
    flag: '--copilot-dir <path>',
    help: 'Path to GitHub Copilot OTEL directory',
  },
  {
    id: 'gemini',
    optionKey: 'geminiDir',
    flag: '--gemini-dir <path>',
    help: 'Path to .gemini directory',
  },
  {
    id: 'droid',
    optionKey: 'droidDir',
    flag: '--droid-dir <path>',
    help: 'Path to Droid sessions directory',
  },
  {
    id: 'claude',
    optionKey: 'claudeDir',
    flag: '--claude-dir <path>',
    help: 'Path to Claude projects directory',
  },
  {
    id: 'openclaw',
    optionKey: 'openclawDir',
    flag: '--openclaw-dir <path>',
    help: 'Path to OpenClaw agents directory',
  },
  {
    id: 'opencode',
    optionKey: 'opencodeDb',
    flag: '--opencode-db <path>',
    help: 'Path to OpenCode SQLite DB',
  },
  { id: 'goose', optionKey: 'gooseDb', flag: '--goose-db <path>', help: 'Path to Goose SQLite DB' },
  {
    id: 'amp',
    optionKey: 'ampDir',
    flag: '--amp-dir <path>',
    help: 'Path to Amp threads directory',
  },
  {
    id: 'qwen',
    optionKey: 'qwenDir',
    flag: '--qwen-dir <path>',
    help: 'Path to Qwen projects directory',
  },
  {
    id: 'kimi',
    optionKey: 'kimiDir',
    flag: '--kimi-dir <path>',
    help: 'Path to Kimi sessions directory',
  },
  {
    id: 'cline',
    optionKey: 'clineDir',
    flag: '--cline-dir <path>',
    help: 'Path to Cline tasks directory',
  },
  {
    id: 'roocode',
    optionKey: 'roocodeDir',
    flag: '--roocode-dir <path>',
    help: 'Path to RooCode tasks directory',
  },
  {
    id: 'kilocode',
    optionKey: 'kilocodeDir',
    flag: '--kilocode-dir <path>',
    help: 'Path to KiloCode tasks directory',
  },
  {
    id: 'antigravity',
    optionKey: 'antigravityDir',
    flag: '--antigravity-dir <path>',
    help: 'Path to Antigravity conversations directory',
  },
] as const;

const SOURCE_DIR_UNSUPPORTED_IDS = new Set(['opencode', 'goose']);

function loadedConfigWith(config: LoadedUserConfig['config']): LoadedUserConfig {
  return {
    config,
    path: '/tmp/config.toml',
    exists: true,
    warnings: [],
  };
}

function collectSourceDirSchemaIds(schema: Record<string, unknown>): string[] {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const sourceDirs = properties?.sourceDirs as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(sourceDirs?.properties ?? {});
}

describe('source metadata manifest', () => {
  it('exposes dedicated override options with frozen flag, help, key, and order', () => {
    expect(
      getSourceOverrideOptions().map((option) => ({
        id: option.id,
        optionKey: option.optionKey,
        flag: option.flag,
        help: option.help,
      })),
    ).toEqual(EXPECTED_OVERRIDE_OPTIONS);
  });

  it('marks db-backed sources as unsupported by --source-dir', () => {
    for (const option of getSourceOverrideOptions()) {
      expect(option.supportsSourceDir).toBe(!SOURCE_DIR_UNSUPPORTED_IDS.has(option.id));
    }
  });

  it('keeps getDefaultSourceIds order byte-identical to the registration order', () => {
    expect(getDefaultSourceIds()).toEqual([
      'pi',
      'codex',
      'gemini',
      'droid',
      'opencode',
      'openclaw',
      'claude',
      'copilot',
      'goose',
      'amp',
      'qwen',
      'kimi',
      'cline',
      'roocode',
      'kilocode',
      'antigravity',
    ]);
  });

  it('keeps USER_CONFIG_SOURCE_DIR_KEYS in sync with the manifest source ids', () => {
    expect(new Set(USER_CONFIG_SOURCE_DIR_KEYS)).toEqual(
      new Set(getSourceOverrideOptions().map((option) => option.id)),
    );
  });

  it('registers sourceDirs.<id> as a known config key for every manifest source', () => {
    for (const option of getSourceOverrideOptions()) {
      expect(USER_CONFIG_KNOWN_KEY_PATHS).toContain(`sourceDirs.${option.id}`);
    }
  });

  it('maps every manifest source id to its dedicated option key through user config', () => {
    for (const option of getSourceOverrideOptions()) {
      const resolution = applyUserConfigToReportOptions(
        {},
        loadedConfigWith({ sourceDirs: { [option.id]: '/tmp/from-config' } }),
      );

      expect(resolution.options[option.optionKey as keyof ReportCommandOptions]).toBe(
        '/tmp/from-config',
      );
      expect(resolution.activeConfig?.entries).toContainEqual({
        key: `sourceDirs.${option.id}`,
        value: '/tmp/from-config',
      });
    }
  });

  it('includes sourceDirs.<id> in both published schema copies for every manifest source', async () => {
    const schema = JSON.parse(await readFile('schema/config.schema.json', 'utf8')) as Record<
      string,
      unknown
    >;
    const publishedSchema = JSON.parse(
      await readFile('site/public/config-schema.json', 'utf8'),
    ) as Record<string, unknown>;

    const manifestIds = getSourceOverrideOptions().map((option) => option.id);

    for (const id of manifestIds) {
      expect(collectSourceDirSchemaIds(schema)).toContain(id);
      expect(collectSourceDirSchemaIds(publishedSchema)).toContain(id);
    }
  });
});
