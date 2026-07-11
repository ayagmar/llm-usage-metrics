import { AmpSourceAdapter } from './amp/amp-source-adapter.js';
import { AntigravitySourceAdapter } from './antigravity/antigravity-source-adapter.js';
import { ClaudeSourceAdapter } from './claude/claude-source-adapter.js';
import { CLINE_EXTENSION_IDS, createClineFamilyAdapter } from './cline/cline-family-adapter.js';
import { CodexSourceAdapter } from './codex/codex-source-adapter.js';
import { CopilotSourceAdapter } from './copilot/copilot-source-adapter.js';
import { DroidSourceAdapter } from './droid/droid-source-adapter.js';
import { GeminiSourceAdapter } from './gemini/gemini-source-adapter.js';
import { GooseSourceAdapter } from './goose/goose-source-adapter.js';
import { KimiSourceAdapter } from './kimi/kimi-source-adapter.js';
import { OpenCodeSourceAdapter } from './opencode/opencode-source-adapter.js';
import { OpenClawSourceAdapter } from './openclaw/openclaw-source-adapter.js';
import { PiSourceAdapter } from './pi/pi-source-adapter.js';
import { QwenSourceAdapter } from './qwen/qwen-source-adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { parseSourceDirectoryOverrides } from '../utils/source-directory-overrides.js';

export type SourceStorageFormat = 'jsonl' | 'json' | 'sqlite';

export type CreateDefaultAdaptersOptions = {
  piDir?: string;
  codexDir?: string;
  copilotDir?: string;
  geminiDir?: string;
  droidDir?: string;
  claudeDir?: string;
  openclawDir?: string;
  opencodeDb?: string;
  gooseDb?: string;
  ampDir?: string;
  qwenDir?: string;
  kimiDir?: string;
  clineDir?: string;
  roocodeDir?: string;
  kilocodeDir?: string;
  antigravityDir?: string;
  sourceDir?: string[];
};

// Dedicated override option keys are derived from the explicit options type above
// so the manifest and the parsed CLI options can never disagree on their names.
type SourceOverrideOptionKey = Exclude<keyof CreateDefaultAdaptersOptions, 'sourceDir'>;

type SourceRegistration = {
  id: string;
  format: SourceStorageFormat;
  supportsSourceDir: boolean;
  option: {
    key: SourceOverrideOptionKey;
    flag: string;
    help: string;
  };
  create: (
    options: CreateDefaultAdaptersOptions,
    sourceDirectoryOverrides: ReadonlyMap<string, string>,
  ) => SourceAdapter;
};

const sourceRegistrations: readonly SourceRegistration[] = [
  {
    id: 'pi',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'piDir', flag: '--pi-dir <path>', help: 'Path to .pi sessions directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig('pi', options.piDir, sourceDirectoryOverrides);

      return new PiSourceAdapter({
        sessionsDir: directoryConfig.path,
        requireSessionsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'codex',
    format: 'jsonl',
    supportsSourceDir: true,
    option: {
      key: 'codexDir',
      flag: '--codex-dir <path>',
      help: 'Path to .codex sessions directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'codex',
        options.codexDir,
        sourceDirectoryOverrides,
      );

      return new CodexSourceAdapter({
        sessionsDir: directoryConfig.path,
        requireSessionsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'gemini',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'geminiDir', flag: '--gemini-dir <path>', help: 'Path to .gemini directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'gemini',
        options.geminiDir,
        sourceDirectoryOverrides,
      );

      return new GeminiSourceAdapter({
        geminiDir: directoryConfig.path,
        requireGeminiDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'droid',
    format: 'json',
    supportsSourceDir: true,
    option: {
      key: 'droidDir',
      flag: '--droid-dir <path>',
      help: 'Path to Droid sessions directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'droid',
        options.droidDir,
        sourceDirectoryOverrides,
      );

      return new DroidSourceAdapter({
        sessionsDir: directoryConfig.path,
        requireSessionsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'opencode',
    format: 'sqlite',
    supportsSourceDir: false,
    option: {
      key: 'opencodeDb',
      flag: '--opencode-db <path>',
      help: 'Path to OpenCode SQLite DB',
    },
    create: (options) =>
      new OpenCodeSourceAdapter({
        dbPath: options.opencodeDb,
      }),
  },
  {
    id: 'openclaw',
    format: 'jsonl',
    supportsSourceDir: true,
    option: {
      key: 'openclawDir',
      flag: '--openclaw-dir <path>',
      help: 'Path to OpenClaw agents directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'openclaw',
        options.openclawDir,
        sourceDirectoryOverrides,
      );

      return new OpenClawSourceAdapter({
        agentsDir: directoryConfig.path,
        requireAgentsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'claude',
    format: 'jsonl',
    supportsSourceDir: true,
    option: {
      key: 'claudeDir',
      flag: '--claude-dir <path>',
      help: 'Path to Claude projects directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'claude',
        options.claudeDir,
        sourceDirectoryOverrides,
      );

      return new ClaudeSourceAdapter({
        projectsDir: directoryConfig.path,
        requireProjectsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'copilot',
    format: 'jsonl',
    supportsSourceDir: true,
    option: {
      key: 'copilotDir',
      flag: '--copilot-dir <path>',
      help: 'Path to GitHub Copilot OTEL directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'copilot',
        options.copilotDir,
        sourceDirectoryOverrides,
      );

      return new CopilotSourceAdapter({
        otelDir: directoryConfig.path,
        requireOtelDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'goose',
    format: 'sqlite',
    supportsSourceDir: false,
    option: { key: 'gooseDb', flag: '--goose-db <path>', help: 'Path to Goose SQLite DB' },
    create: (options) =>
      new GooseSourceAdapter({
        dbPath: options.gooseDb,
      }),
  },
  {
    id: 'amp',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'ampDir', flag: '--amp-dir <path>', help: 'Path to Amp threads directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'amp',
        options.ampDir,
        sourceDirectoryOverrides,
      );

      return new AmpSourceAdapter({
        threadsDir: directoryConfig.path,
        requireThreadsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'qwen',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'qwenDir', flag: '--qwen-dir <path>', help: 'Path to Qwen projects directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'qwen',
        options.qwenDir,
        sourceDirectoryOverrides,
      );

      return new QwenSourceAdapter({
        projectsDir: directoryConfig.path,
        requireProjectsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'kimi',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'kimiDir', flag: '--kimi-dir <path>', help: 'Path to Kimi sessions directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'kimi',
        options.kimiDir,
        sourceDirectoryOverrides,
      );

      return new KimiSourceAdapter({
        kimiDir: directoryConfig.path,
        requireKimiDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'cline',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'clineDir', flag: '--cline-dir <path>', help: 'Path to Cline tasks directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'cline',
        options.clineDir,
        sourceDirectoryOverrides,
      );

      return createClineFamilyAdapter({
        id: 'cline',
        extensionId: CLINE_EXTENSION_IDS.cline,
        tasksDir: directoryConfig.path,
        requireTasksDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'roocode',
    format: 'json',
    supportsSourceDir: true,
    option: {
      key: 'roocodeDir',
      flag: '--roocode-dir <path>',
      help: 'Path to RooCode tasks directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'roocode',
        options.roocodeDir,
        sourceDirectoryOverrides,
      );

      return createClineFamilyAdapter({
        id: 'roocode',
        extensionId: CLINE_EXTENSION_IDS.roocode,
        tasksDir: directoryConfig.path,
        requireTasksDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'kilocode',
    format: 'json',
    supportsSourceDir: true,
    option: {
      key: 'kilocodeDir',
      flag: '--kilocode-dir <path>',
      help: 'Path to KiloCode tasks directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'kilocode',
        options.kilocodeDir,
        sourceDirectoryOverrides,
      );

      return createClineFamilyAdapter({
        id: 'kilocode',
        extensionId: CLINE_EXTENSION_IDS.kilocode,
        tasksDir: directoryConfig.path,
        requireTasksDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'antigravity',
    format: 'sqlite',
    supportsSourceDir: true,
    option: {
      key: 'antigravityDir',
      flag: '--antigravity-dir <path>',
      help: 'Path to Antigravity conversations directory',
    },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'antigravity',
        options.antigravityDir,
        sourceDirectoryOverrides,
      );

      return new AntigravitySourceAdapter({
        conversationsDir: directoryConfig.path,
        requireConversationsDir: directoryConfig.requireExistingPath,
      });
    },
  },
];

// Order of the dedicated per-source override flags in `--help` and the generated
// CLI reference. Intentionally distinct from the registration order above (preserved
// by getDefaultSourceIds); the source-metadata parity test guards that both lists
// cover the same source ids.
const dedicatedOptionOrderIds = [
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
] as const;

function dedicatedFlagName(flag: string): string {
  return flag.split(' ')[0];
}

const sourceDirUnsupportedFlags = new Map(
  sourceRegistrations
    .filter((source) => !source.supportsSourceDir)
    .map((source) => [source.id, dedicatedFlagName(source.option.flag)]),
);

const sourceDirSupportedIds = new Set(
  sourceRegistrations.filter((source) => source.supportsSourceDir).map((source) => source.id),
);

export type SourceOverrideOption = {
  id: string;
  optionKey: SourceOverrideOptionKey;
  flag: string;
  help: string;
  supportsSourceDir: boolean;
};

export function getSourceOverrideOptions(): readonly SourceOverrideOption[] {
  return dedicatedOptionOrderIds.map((id) => {
    const registration = sourceRegistrations.find((source) => source.id === id);

    if (!registration) {
      throw new Error(`Unknown source id in dedicated option order: ${id}`);
    }

    return {
      id: registration.id,
      optionKey: registration.option.key,
      flag: registration.option.flag,
      help: registration.option.help,
      supportsSourceDir: registration.supportsSourceDir,
    };
  });
}

function validateSourceDirectoryOverrideIds(
  sourceDirectoryOverrides: ReadonlyMap<string, string>,
): void {
  const nonDirectorySourceOverrides = [...sourceDirectoryOverrides.keys()].filter((sourceId) =>
    sourceDirUnsupportedFlags.has(sourceId),
  );

  if (nonDirectorySourceOverrides.length > 0) {
    const sourceId = nonDirectorySourceOverrides[0];
    const flag = sourceDirUnsupportedFlags.get(sourceId);

    throw new Error(`--source-dir does not support "${sourceId}". Use ${flag} instead.`);
  }

  const unknownSourceIds = [...sourceDirectoryOverrides.keys()].filter(
    (sourceId) => !sourceDirSupportedIds.has(sourceId),
  );

  if (unknownSourceIds.length === 0) {
    return;
  }

  const allowedSourceIds = [...sourceDirSupportedIds].sort(compareByCodePoint);

  throw new Error(
    `Unknown --source-dir source id(s): ${unknownSourceIds.join(', ')}. Allowed values: ${allowedSourceIds.join(', ')}`,
  );
}

function validateOverridePath(flagName: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  if (value.trim().length === 0) {
    throw new Error(`${flagName} must be a non-empty path`);
  }
}

function resolveDirectoryConfig(
  sourceId: string,
  explicitDirectory: string | undefined,
  sourceDirectoryOverrides: ReadonlyMap<string, string>,
): {
  path: string | undefined;
  requireExistingPath: boolean;
} {
  if (explicitDirectory !== undefined) {
    return {
      path: explicitDirectory,
      requireExistingPath: true,
    };
  }

  const sourceDirOverride = sourceDirectoryOverrides.get(sourceId);

  if (sourceDirOverride !== undefined) {
    return {
      path: sourceDirOverride,
      requireExistingPath: true,
    };
  }

  return {
    path: undefined,
    requireExistingPath: false,
  };
}

export function getDefaultSourceIds(): string[] {
  return sourceRegistrations.map((source) => source.id);
}

export function getSourceStorageFormat(sourceId: string): SourceStorageFormat {
  const registration = sourceRegistrations.find((source) => source.id === sourceId);

  if (!registration) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }

  return registration.format;
}

export function createDefaultAdapters(options: CreateDefaultAdaptersOptions): SourceAdapter[] {
  for (const source of sourceRegistrations) {
    validateOverridePath(dedicatedFlagName(source.option.flag), options[source.option.key]);
  }

  const sourceDirectoryOverrides = parseSourceDirectoryOverrides(options.sourceDir);
  validateSourceDirectoryOverrideIds(sourceDirectoryOverrides);

  return sourceRegistrations.map((source) => source.create(options, sourceDirectoryOverrides));
}
