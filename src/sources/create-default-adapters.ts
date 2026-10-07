import { AmpSourceAdapter } from './amp/amp-source-adapter.js';
import { AntigravitySourceAdapter } from './antigravity/antigravity-source-adapter.js';
import { ClaudeSourceAdapter } from './claude/claude-source-adapter.js';
import { CLINE_EXTENSION_IDS, createClineFamilyAdapter } from './cline/cline-family-adapter.js';
import { CodexSourceAdapter } from './codex/codex-source-adapter.js';
import { CopilotSourceAdapter } from './copilot/copilot-source-adapter.js';
import { DroidSourceAdapter } from './droid/droid-source-adapter.js';
import { DshSourceAdapter } from './dsh/dsh-source-adapter.js';
import { GeminiSourceAdapter } from './gemini/gemini-source-adapter.js';
import { GooseSourceAdapter } from './goose/goose-source-adapter.js';
import { KimiSourceAdapter } from './kimi/kimi-source-adapter.js';
import { OpenCodeSourceAdapter } from './opencode/opencode-source-adapter.js';
import { OpenClawSourceAdapter } from './openclaw/openclaw-source-adapter.js';
import { PiSourceAdapter } from './pi/pi-source-adapter.js';
import { QwenSourceAdapter } from './qwen/qwen-source-adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  parseSourceDirectoryOverrides,
  type SourceDirectoryValue,
  toSourceDirectoryList,
} from '../utils/source-directory-overrides.js';
import { MultiDirectorySourceAdapter } from './multi-directory-source-adapter.js';

export type SourceStorageFormat = 'jsonl' | 'json' | 'sqlite';

export type CreateDefaultAdaptersOptions = {
  piDir?: SourceDirectoryValue;
  codexDir?: SourceDirectoryValue;
  copilotDir?: SourceDirectoryValue;
  geminiDir?: SourceDirectoryValue;
  droidDir?: SourceDirectoryValue;
  claudeDir?: SourceDirectoryValue;
  openclawDir?: SourceDirectoryValue;
  opencodeDb?: string;
  gooseDb?: string;
  ampDir?: SourceDirectoryValue;
  qwenDir?: SourceDirectoryValue;
  kimiDir?: SourceDirectoryValue;
  clineDir?: SourceDirectoryValue;
  roocodeDir?: SourceDirectoryValue;
  kilocodeDir?: SourceDirectoryValue;
  antigravityDir?: SourceDirectoryValue;
  dshDir?: SourceDirectoryValue;
  sourceDir?: string[];
};

// Dedicated override option keys are derived from the explicit options type above
// so the manifest and the parsed CLI options can never disagree on their names.
type SourceOverrideOptionKey = Exclude<keyof CreateDefaultAdaptersOptions, 'sourceDir'>;

type ResolvedSourcePath = {
  path: string | undefined;
  requireExistingPath: boolean;
};

type SourceRegistration = {
  id: string;
  format: SourceStorageFormat;
  /** Directory-backed: accepts --source-dir and repeated directory flags. */
  supportsSourceDir: boolean;
  /**
   * Builds one adapter over several directories. Without it, each directory gets its own
   * adapter behind MultiDirectorySourceAdapter.
   */
  createForDirectories?: (directories: readonly string[]) => SourceAdapter;
  option: {
    key: SourceOverrideOptionKey;
    flag: string;
    help: string;
  };
  create: (resolved: ResolvedSourcePath) => SourceAdapter;
};

const dirOptions = ({ path, requireExistingPath }: ResolvedSourcePath) => ({
  dir: path,
  requireDir: requireExistingPath,
});

const sourceRegistrations: readonly SourceRegistration[] = [
  {
    id: 'pi',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'piDir', flag: '--pi-dir <path>', help: 'Path to .pi sessions directory' },
    create: (resolved) => new PiSourceAdapter(dirOptions(resolved)),
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
    create: (resolved) => new CodexSourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'gemini',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'geminiDir', flag: '--gemini-dir <path>', help: 'Path to .gemini directory' },
    create: (resolved) => new GeminiSourceAdapter(dirOptions(resolved)),
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
    create: (resolved) => new DroidSourceAdapter(dirOptions(resolved)),
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
    create: ({ path }) => new OpenCodeSourceAdapter({ dbPath: path }),
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
    create: (resolved) => new OpenClawSourceAdapter(dirOptions(resolved)),
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
    create: (resolved) => new ClaudeSourceAdapter(dirOptions(resolved)),
    // Fork deduplication needs every root in one adapter to find a parent transcript.
    createForDirectories: (directories) =>
      new ClaudeSourceAdapter({ dir: directories, requireDir: true }),
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
    create: (resolved) => new CopilotSourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'goose',
    format: 'sqlite',
    supportsSourceDir: false,
    option: { key: 'gooseDb', flag: '--goose-db <path>', help: 'Path to Goose SQLite DB' },
    create: ({ path }) => new GooseSourceAdapter({ dbPath: path }),
  },
  {
    id: 'amp',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'ampDir', flag: '--amp-dir <path>', help: 'Path to Amp threads directory' },
    create: (resolved) => new AmpSourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'qwen',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'qwenDir', flag: '--qwen-dir <path>', help: 'Path to Qwen projects directory' },
    create: (resolved) => new QwenSourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'kimi',
    format: 'jsonl',
    supportsSourceDir: true,
    option: { key: 'kimiDir', flag: '--kimi-dir <path>', help: 'Path to Kimi sessions directory' },
    create: (resolved) => new KimiSourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'cline',
    format: 'json',
    supportsSourceDir: true,
    option: { key: 'clineDir', flag: '--cline-dir <path>', help: 'Path to Cline tasks directory' },
    create: (resolved) =>
      createClineFamilyAdapter({
        id: 'cline',
        extensionId: CLINE_EXTENSION_IDS.cline,
        ...dirOptions(resolved),
      }),
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
    create: (resolved) =>
      createClineFamilyAdapter({
        id: 'roocode',
        extensionId: CLINE_EXTENSION_IDS.roocode,
        ...dirOptions(resolved),
      }),
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
    create: (resolved) =>
      createClineFamilyAdapter({
        id: 'kilocode',
        extensionId: CLINE_EXTENSION_IDS.kilocode,
        ...dirOptions(resolved),
      }),
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
    create: (resolved) => new AntigravitySourceAdapter(dirOptions(resolved)),
  },
  {
    id: 'dsh',
    format: 'jsonl',
    supportsSourceDir: true,
    option: {
      key: 'dshDir',
      flag: '--dsh-dir <path>',
      help: 'Path to DeepSeek Harness sessions directory',
    },
    create: (resolved) => new DshSourceAdapter(dirOptions(resolved)),
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
  'dsh',
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
  sourceDirectoryOverrides: ReadonlyMap<string, readonly string[]>,
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

function validateOverridePath(
  flagName: string,
  value: SourceDirectoryValue | undefined,
  allowsSeveral: boolean,
): void {
  const paths = toSourceDirectoryList(value);

  if (paths.some((overridePath) => overridePath.trim().length === 0)) {
    throw new Error(`${flagName} must be a non-empty path`);
  }

  if (!allowsSeveral && paths.length > 1) {
    throw new Error(`${flagName} takes a single path`);
  }
}

/** Dedicated flags win over --source-dir; each lists one or more directories. */
function resolveDirectories(
  sourceId: string,
  explicitDirectories: SourceDirectoryValue | undefined,
  sourceDirectoryOverrides: ReadonlyMap<string, readonly string[]>,
): string[] {
  const directories = toSourceDirectoryList(explicitDirectories);

  if (directories.length > 0) {
    return [...new Set(directories)];
  }

  return [...(sourceDirectoryOverrides.get(sourceId) ?? [])];
}

function createDirectoryBackedAdapter(
  source: SourceRegistration,
  directories: readonly string[],
): SourceAdapter {
  if (directories.length === 0) {
    return source.create({ path: undefined, requireExistingPath: false });
  }

  if (directories.length === 1) {
    return source.create({ path: directories[0], requireExistingPath: true });
  }

  return (
    source.createForDirectories?.(directories) ??
    new MultiDirectorySourceAdapter(
      directories.map((directory) => source.create({ path: directory, requireExistingPath: true })),
    )
  );
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
    validateOverridePath(
      dedicatedFlagName(source.option.flag),
      options[source.option.key],
      source.supportsSourceDir,
    );
  }

  const sourceDirectoryOverrides = parseSourceDirectoryOverrides(options.sourceDir);
  validateSourceDirectoryOverrideIds(sourceDirectoryOverrides);

  return sourceRegistrations.map((source) => {
    if (!source.supportsSourceDir) {
      const [dbPath] = toSourceDirectoryList(options[source.option.key]);
      return source.create({ path: dbPath, requireExistingPath: false });
    }

    return createDirectoryBackedAdapter(
      source,
      resolveDirectories(source.id, options[source.option.key], sourceDirectoryOverrides),
    );
  });
}
