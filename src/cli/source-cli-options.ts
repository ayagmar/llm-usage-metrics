import {
  createDefaultAdapters,
  getDefaultSourceIds,
  type SourceSelection,
  sourceSupportsDirectories,
} from '@ayagmar/agent-sessions/registry';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import {
  type SourceDirectoryValue,
  toSourceDirectoryList,
} from '../utils/source-directory-overrides.js';

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

type SourceCliOption = {
  key: SourceOverrideOptionKey;
  flag: string;
  help: string;
};

// Keyed by source id; validation walks the sources in registration order
// (getDefaultSourceIds), not in this order.
const sourceCliOptions: ReadonlyMap<string, SourceCliOption> = new Map([
  ['pi', { key: 'piDir', flag: '--pi-dir <path>', help: 'Path to .pi sessions directory' }],
  [
    'codex',
    {
      key: 'codexDir',
      flag: '--codex-dir <path>',
      help: 'Path to .codex sessions directory',
    },
  ],
  ['gemini', { key: 'geminiDir', flag: '--gemini-dir <path>', help: 'Path to .gemini directory' }],
  [
    'droid',
    {
      key: 'droidDir',
      flag: '--droid-dir <path>',
      help: 'Path to Droid sessions directory',
    },
  ],
  [
    'opencode',
    {
      key: 'opencodeDb',
      flag: '--opencode-db <path>',
      help: 'Path to OpenCode SQLite DB',
    },
  ],
  [
    'openclaw',
    {
      key: 'openclawDir',
      flag: '--openclaw-dir <path>',
      help: 'Path to OpenClaw agents directory',
    },
  ],
  [
    'claude',
    {
      key: 'claudeDir',
      flag: '--claude-dir <path>',
      help: 'Path to Claude projects directory',
    },
  ],
  [
    'copilot',
    {
      key: 'copilotDir',
      flag: '--copilot-dir <path>',
      help: 'Path to GitHub Copilot OTEL directory',
    },
  ],
  ['goose', { key: 'gooseDb', flag: '--goose-db <path>', help: 'Path to Goose SQLite DB' }],
  ['amp', { key: 'ampDir', flag: '--amp-dir <path>', help: 'Path to Amp threads directory' }],
  ['qwen', { key: 'qwenDir', flag: '--qwen-dir <path>', help: 'Path to Qwen projects directory' }],
  ['kimi', { key: 'kimiDir', flag: '--kimi-dir <path>', help: 'Path to Kimi sessions directory' }],
  ['cline', { key: 'clineDir', flag: '--cline-dir <path>', help: 'Path to Cline tasks directory' }],
  [
    'roocode',
    {
      key: 'roocodeDir',
      flag: '--roocode-dir <path>',
      help: 'Path to RooCode tasks directory',
    },
  ],
  [
    'kilocode',
    {
      key: 'kilocodeDir',
      flag: '--kilocode-dir <path>',
      help: 'Path to KiloCode tasks directory',
    },
  ],
  [
    'antigravity',
    {
      key: 'antigravityDir',
      flag: '--antigravity-dir <path>',
      help: 'Path to Antigravity conversations directory',
    },
  ],
  [
    'dsh',
    {
      key: 'dshDir',
      flag: '--dsh-dir <path>',
      help: 'Path to DeepSeek Harness sessions directory',
    },
  ],
]);

// Order of the dedicated per-source override flags in `--help` and the generated
// CLI reference. Intentionally distinct from the registration order (preserved
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

function getSourceCliOption(sourceId: string): SourceCliOption {
  const option = sourceCliOptions.get(sourceId);

  if (!option) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }

  return option;
}

function dedicatedFlagName(flag: string): string {
  return flag.split(' ')[0];
}

export type SourceOverrideOption = {
  id: string;
  optionKey: SourceOverrideOptionKey;
  flag: string;
  help: string;
  supportsSourceDir: boolean;
};

export function getSourceOverrideOptions(): readonly SourceOverrideOption[] {
  return dedicatedOptionOrderIds.map((id) => {
    const option = sourceCliOptions.get(id);

    if (!option) {
      throw new Error(`Unknown source id in dedicated option order: ${id}`);
    }

    return {
      id,
      optionKey: option.key,
      flag: option.flag,
      help: option.help,
      supportsSourceDir: sourceSupportsDirectories(id),
    };
  });
}

/** Parses repeated `--source-dir <source-id>=<path>` entries; a source may repeat. */
export function parseSourceDirectoryOverrides(
  entries: readonly string[] | undefined,
): Map<string, string[]> {
  const overrides = new Map<string, string[]>();

  if (!entries || entries.length === 0) {
    return overrides;
  }

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');

    if (separatorIndex <= 0 || separatorIndex >= entry.length - 1) {
      throw new Error('--source-dir must use format <source-id>=<path>');
    }

    const sourceId = entry.slice(0, separatorIndex).trim().toLowerCase();
    const directoryPath = entry.slice(separatorIndex + 1).trim();

    if (!sourceId || !directoryPath) {
      throw new Error('--source-dir must use non-empty <source-id>=<path> values');
    }

    const directories = overrides.get(sourceId) ?? [];

    if (!directories.includes(directoryPath)) {
      directories.push(directoryPath);
    }

    overrides.set(sourceId, directories);
  }

  return overrides;
}

function validateSourceDirectoryOverrideIds(
  sourceDirectoryOverrides: ReadonlyMap<string, readonly string[]>,
): void {
  const sourceIds = getDefaultSourceIds();
  const nonDirectorySourceOverrides = [...sourceDirectoryOverrides.keys()].filter(
    (sourceId) => sourceIds.includes(sourceId) && !sourceSupportsDirectories(sourceId),
  );

  if (nonDirectorySourceOverrides.length > 0) {
    const sourceId = nonDirectorySourceOverrides[0];
    const flag = dedicatedFlagName(getSourceCliOption(sourceId).flag);

    throw new Error(`--source-dir does not support "${sourceId}". Use ${flag} instead.`);
  }

  const unknownSourceIds = [...sourceDirectoryOverrides.keys()].filter(
    (sourceId) => !sourceSupportsDirectories(sourceId),
  );

  if (unknownSourceIds.length === 0) {
    return;
  }

  const allowedSourceIds = sourceIds
    .filter((sourceId) => sourceSupportsDirectories(sourceId))
    .sort(compareByCodePoint);

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

/**
 * Validates the per-source flags (in registration order), then `--source-dir`, and maps them
 * to the roots each source reads. A directory given on the command line must exist; a DB path
 * may be missing.
 */
function resolveSourceSelection(options: CreateDefaultAdaptersOptions): SourceSelection {
  const sourceIds = getDefaultSourceIds();

  for (const sourceId of sourceIds) {
    const option = getSourceCliOption(sourceId);

    validateOverridePath(
      dedicatedFlagName(option.flag),
      options[option.key],
      sourceSupportsDirectories(sourceId),
    );
  }

  const sourceDirectoryOverrides = parseSourceDirectoryOverrides(options.sourceDir);
  validateSourceDirectoryOverrideIds(sourceDirectoryOverrides);

  const roots = new Map<string, readonly string[]>();
  const requireExistingRoots = new Set<string>();

  for (const sourceId of sourceIds) {
    const value = options[getSourceCliOption(sourceId).key];

    if (!sourceSupportsDirectories(sourceId)) {
      roots.set(sourceId, toSourceDirectoryList(value).slice(0, 1));
      continue;
    }

    const directories = resolveDirectories(sourceId, value, sourceDirectoryOverrides);
    roots.set(sourceId, directories);

    if (directories.length > 0) {
      requireExistingRoots.add(sourceId);
    }
  }

  return { roots, requireExistingRoots, sourceIds };
}

export function createAdaptersFromOptions(options: CreateDefaultAdaptersOptions): SourceAdapter[] {
  return createDefaultAdapters(resolveSourceSelection(options));
}
