import { CodexSourceAdapter } from './codex/codex-source-adapter.js';
import { CopilotCliSourceAdapter } from './copilot-cli/copilot-cli-source-adapter.js';
import { CopilotVscodeSourceAdapter } from './copilot-vscode/copilot-vscode-source-adapter.js';
import { DroidSourceAdapter } from './droid/droid-source-adapter.js';
import { GeminiSourceAdapter } from './gemini/gemini-source-adapter.js';
import { OpenCodeSourceAdapter } from './opencode/opencode-source-adapter.js';
import { PiSourceAdapter } from './pi/pi-source-adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

type SourceRegistration = {
  id: string;
  sourceDirOverride: { kind: 'directory' } | { kind: 'unsupported'; flag: string };
  create: (
    options: CreateDefaultAdaptersOptions,
    sourceDirectoryOverrides: ReadonlyMap<string, string>,
  ) => SourceAdapter;
};

export type CreateDefaultAdaptersOptions = {
  piDir?: string;
  codexDir?: string;
  geminiDir?: string;
  droidDir?: string;
  copilotCliDir?: string;
  copilotVscodeDir?: string;
  opencodeDb?: string;
  sourceDir?: string[];
};

function parseSourceDirectoryOverrides(entries: string[] | undefined): Map<string, string> {
  const overrides = new Map<string, string>();

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

    if (overrides.has(sourceId)) {
      throw new Error(`Duplicate --source-dir source id: ${sourceId}`);
    }

    overrides.set(sourceId, directoryPath);
  }

  return overrides;
}

const sourceRegistrations: readonly SourceRegistration[] = [
  {
    id: 'pi',
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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
    id: 'copilot-cli',
    sourceDirOverride: { kind: 'directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'copilot-cli',
        options.copilotCliDir,
        sourceDirectoryOverrides,
      );

      return new CopilotCliSourceAdapter({
        sessionsDir: directoryConfig.path,
        requireSessionsDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'copilot-vscode',
    sourceDirOverride: { kind: 'directory' },
    create: (options, sourceDirectoryOverrides) => {
      const directoryConfig = resolveDirectoryConfig(
        'copilot-vscode',
        options.copilotVscodeDir,
        sourceDirectoryOverrides,
      );

      return new CopilotVscodeSourceAdapter({
        workspaceStorageDir: directoryConfig.path,
        requireWorkspaceStorageDir: directoryConfig.requireExistingPath,
      });
    },
  },
  {
    id: 'opencode',
    sourceDirOverride: { kind: 'unsupported', flag: '--opencode-db' },
    create: (options) =>
      new OpenCodeSourceAdapter({
        dbPath: options.opencodeDb,
      }),
  },
];

const sourceDirUnsupportedFlags = new Map(
  sourceRegistrations
    .filter(
      (
        source,
      ): source is SourceRegistration & {
        sourceDirOverride: { kind: 'unsupported'; flag: string };
      } => source.sourceDirOverride.kind === 'unsupported',
    )
    .map((source) => [source.id, source.sourceDirOverride.flag]),
);

const sourceDirSupportedIds = new Set(
  sourceRegistrations
    .filter(
      (source): source is SourceRegistration & { sourceDirOverride: { kind: 'directory' } } =>
        source.sourceDirOverride.kind === 'directory',
    )
    .map((source) => source.id),
);

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

function validateOpencodeOverride(opencodeDb: string | undefined): void {
  if (opencodeDb === undefined) {
    return;
  }

  if (opencodeDb.trim().length === 0) {
    throw new Error('--opencode-db must be a non-empty path');
  }
}

function validateDirectoryOverride(
  optionName:
    | '--pi-dir'
    | '--codex-dir'
    | '--gemini-dir'
    | '--droid-dir'
    | '--copilot-cli-dir'
    | '--copilot-vscode-dir',
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (value.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty path`);
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

export function createDefaultAdapters(options: CreateDefaultAdaptersOptions): SourceAdapter[] {
  validateOpencodeOverride(options.opencodeDb);
  validateDirectoryOverride('--pi-dir', options.piDir);
  validateDirectoryOverride('--codex-dir', options.codexDir);
  validateDirectoryOverride('--gemini-dir', options.geminiDir);
  validateDirectoryOverride('--droid-dir', options.droidDir);
  validateDirectoryOverride('--copilot-cli-dir', options.copilotCliDir);
  validateDirectoryOverride('--copilot-vscode-dir', options.copilotVscodeDir);

  const sourceDirectoryOverrides = parseSourceDirectoryOverrides(options.sourceDir);
  validateSourceDirectoryOverrideIds(sourceDirectoryOverrides);

  return sourceRegistrations.map((source) => source.create(options, sourceDirectoryOverrides));
}
