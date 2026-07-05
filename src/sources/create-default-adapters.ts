import { AmpSourceAdapter } from './amp/amp-source-adapter.js';
import { ClaudeSourceAdapter } from './claude/claude-source-adapter.js';
import { CodexSourceAdapter } from './codex/codex-source-adapter.js';
import { CopilotSourceAdapter } from './copilot/copilot-source-adapter.js';
import { DroidSourceAdapter } from './droid/droid-source-adapter.js';
import { GeminiSourceAdapter } from './gemini/gemini-source-adapter.js';
import { GooseSourceAdapter } from './goose/goose-source-adapter.js';
import { OpenCodeSourceAdapter } from './opencode/opencode-source-adapter.js';
import { OpenClawSourceAdapter } from './openclaw/openclaw-source-adapter.js';
import { PiSourceAdapter } from './pi/pi-source-adapter.js';
import { QwenSourceAdapter } from './qwen/qwen-source-adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { parseSourceDirectoryOverrides } from '../utils/source-directory-overrides.js';

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
  copilotDir?: string;
  geminiDir?: string;
  droidDir?: string;
  claudeDir?: string;
  openclawDir?: string;
  opencodeDb?: string;
  gooseDb?: string;
  ampDir?: string;
  qwenDir?: string;
  sourceDir?: string[];
};

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
    id: 'opencode',
    sourceDirOverride: { kind: 'unsupported', flag: '--opencode-db' },
    create: (options) =>
      new OpenCodeSourceAdapter({
        dbPath: options.opencodeDb,
      }),
  },
  {
    id: 'openclaw',
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'unsupported', flag: '--goose-db' },
    create: (options) =>
      new GooseSourceAdapter({
        dbPath: options.gooseDb,
      }),
  },
  {
    id: 'amp',
    sourceDirOverride: { kind: 'directory' },
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
    sourceDirOverride: { kind: 'directory' },
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

function validateDbOverride(
  optionName: '--opencode-db' | '--goose-db',
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (value.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty path`);
  }
}

function validateDirectoryOverride(
  optionName:
    | '--pi-dir'
    | '--codex-dir'
    | '--copilot-dir'
    | '--gemini-dir'
    | '--droid-dir'
    | '--claude-dir'
    | '--openclaw-dir'
    | '--amp-dir'
    | '--qwen-dir',
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
  validateDbOverride('--opencode-db', options.opencodeDb);
  validateDbOverride('--goose-db', options.gooseDb);
  validateDirectoryOverride('--pi-dir', options.piDir);
  validateDirectoryOverride('--codex-dir', options.codexDir);
  validateDirectoryOverride('--copilot-dir', options.copilotDir);
  validateDirectoryOverride('--gemini-dir', options.geminiDir);
  validateDirectoryOverride('--droid-dir', options.droidDir);
  validateDirectoryOverride('--claude-dir', options.claudeDir);
  validateDirectoryOverride('--openclaw-dir', options.openclawDir);
  validateDirectoryOverride('--amp-dir', options.ampDir);
  validateDirectoryOverride('--qwen-dir', options.qwenDir);

  const sourceDirectoryOverrides = parseSourceDirectoryOverrides(options.sourceDir);
  validateSourceDirectoryOverrideIds(sourceDirectoryOverrides);

  return sourceRegistrations.map((source) => source.create(options, sourceDirectoryOverrides));
}
