import { AmpSourceAdapter } from '../sources/amp/index.js';
import { AntigravitySourceAdapter } from '../sources/antigravity/index.js';
import { ClaudeSourceAdapter } from '../sources/claude/index.js';
import { CLINE_EXTENSION_IDS, createClineFamilyAdapter } from '../sources/cline/index.js';
import { CodexSourceAdapter } from '../sources/codex/index.js';
import { CopilotSourceAdapter } from '../sources/copilot/index.js';
import { DroidSourceAdapter } from '../sources/droid/index.js';
import { DshSourceAdapter } from '../sources/dsh/index.js';
import { GeminiSourceAdapter } from '../sources/gemini/index.js';
import { GooseSourceAdapter } from '../sources/goose/index.js';
import { KimiSourceAdapter } from '../sources/kimi/index.js';
import { OpenCodeSourceAdapter } from '../sources/opencode/index.js';
import { OpenClawSourceAdapter } from '../sources/openclaw/index.js';
import { PiSourceAdapter } from '../sources/pi/index.js';
import { QwenSourceAdapter } from '../sources/qwen/index.js';
import type { SourceId } from '../domain/usage-event.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { createSourceContext, type SourceContext } from '../sources/source-context.js';
import { MultiDirectorySourceAdapter } from '../sources/multi-directory-source-adapter.js';

export type SourceStorageFormat = 'jsonl' | 'json' | 'sqlite';

/**
 * Which sources to build and where they read from, keyed by source id. A source without
 * roots searches its default locations.
 */
export type SourceSelection = {
  roots?: ReadonlyMap<SourceId, readonly string[]>;
  /** Sources whose roots must exist; the others skip a missing root quietly. */
  requireExistingRoots?: ReadonlySet<SourceId>;
  /** Sources to build, kept in registration order; every source when omitted. */
  sourceIds?: readonly SourceId[];
};

type ResolvedSourcePath = {
  path: string | undefined;
  requireExistingPath: boolean;
};

type SourceRegistration = {
  id: string;
  format: SourceStorageFormat;
  /** Directory-backed: takes several roots. Otherwise a single file path. */
  supportsSourceDir: boolean;
  /**
   * Builds one adapter over several directories. Without it, each directory gets its own
   * adapter behind MultiDirectorySourceAdapter.
   */
  createForDirectories?: (
    directories: readonly string[],
    requireExistingPath: boolean,
    context: SourceContext,
  ) => SourceAdapter;
  /**
   * Parse workers may build this source's adapter with default roots: parsing a file must
   * not read the adapter's roots. Pi and Claude read them for fork parents.
   */
  parseInWorker: boolean;
  create: (resolved: ResolvedSourcePath, context: SourceContext) => SourceAdapter;
};

const dirOptions = ({ path, requireExistingPath }: ResolvedSourcePath, context: SourceContext) => ({
  dir: path,
  requireDir: requireExistingPath,
  context,
});

const sourceRegistrations: readonly SourceRegistration[] = [
  {
    id: 'pi',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new PiSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'codex',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: true,
    create: (resolved, context) => new CodexSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'gemini',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new GeminiSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'droid',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new DroidSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'opencode',
    format: 'sqlite',
    supportsSourceDir: false,
    parseInWorker: false,
    create: ({ path }, context) => new OpenCodeSourceAdapter({ dbPath: path, context }),
  },
  {
    id: 'openclaw',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new OpenClawSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'claude',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new ClaudeSourceAdapter(dirOptions(resolved, context)),
    // Fork deduplication needs every root in one adapter to find a parent transcript.
    createForDirectories: (directories, requireExistingPath, context) =>
      new ClaudeSourceAdapter({ dir: directories, requireDir: requireExistingPath, context }),
  },
  {
    id: 'copilot',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new CopilotSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'goose',
    format: 'sqlite',
    supportsSourceDir: false,
    parseInWorker: false,
    create: ({ path }, context) => new GooseSourceAdapter({ dbPath: path, context }),
  },
  {
    id: 'amp',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new AmpSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'qwen',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new QwenSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'kimi',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new KimiSourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'cline',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) =>
      createClineFamilyAdapter({
        id: 'cline',
        extensionId: CLINE_EXTENSION_IDS.cline,
        ...dirOptions(resolved, context),
      }),
  },
  {
    id: 'roocode',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) =>
      createClineFamilyAdapter({
        id: 'roocode',
        extensionId: CLINE_EXTENSION_IDS.roocode,
        ...dirOptions(resolved, context),
      }),
  },
  {
    id: 'kilocode',
    format: 'json',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) =>
      createClineFamilyAdapter({
        id: 'kilocode',
        extensionId: CLINE_EXTENSION_IDS.kilocode,
        ...dirOptions(resolved, context),
      }),
  },
  {
    id: 'antigravity',
    format: 'sqlite',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new AntigravitySourceAdapter(dirOptions(resolved, context)),
  },
  {
    id: 'dsh',
    format: 'jsonl',
    supportsSourceDir: true,
    parseInWorker: false,
    create: (resolved, context) => new DshSourceAdapter(dirOptions(resolved, context)),
  },
];

function createDirectoryBackedAdapter(
  source: SourceRegistration,
  directories: readonly string[],
  requireExistingPath: boolean,
  context: SourceContext,
): SourceAdapter {
  if (directories.length === 0) {
    return source.create({ path: undefined, requireExistingPath: false }, context);
  }

  if (directories.length === 1) {
    return source.create({ path: directories[0], requireExistingPath }, context);
  }

  return (
    source.createForDirectories?.(directories, requireExistingPath, context) ??
    new MultiDirectorySourceAdapter(
      directories.map((directory) =>
        source.create({ path: directory, requireExistingPath }, context),
      ),
    )
  );
}

export function getDefaultSourceIds(): string[] {
  return sourceRegistrations.map((source) => source.id);
}

/** Whether the source reads directories (and may take several) rather than one file. */
export function sourceSupportsDirectories(sourceId: string): boolean {
  return sourceRegistrations.some((source) => source.id === sourceId && source.supportsSourceDir);
}

export function getSourceStorageFormat(sourceId: string): SourceStorageFormat {
  const registration = sourceRegistrations.find((source) => source.id === sourceId);

  if (!registration) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }

  return registration.format;
}

/** Whether a parse worker can build this source's adapter and parse its files. */
export function canParseSourceOnWorker(sourceId: string): boolean {
  return sourceRegistrations.some((source) => source.id === sourceId && source.parseInWorker);
}

/**
 * The adapter a parse worker parses with: default roots and a context from the worker's own
 * process. Undefined when the source is not registered for worker parsing.
 */
export function createWorkerParseAdapter(sourceId: string): SourceAdapter | undefined {
  const registration = sourceRegistrations.find(
    (source) => source.id === sourceId && source.parseInWorker,
  );

  return registration?.create(
    { path: undefined, requireExistingPath: false },
    createSourceContext(),
  );
}

export function createDefaultAdapters(
  selection: SourceSelection,
  context: SourceContext = createSourceContext(),
): SourceAdapter[] {
  const sourceIds = selection.sourceIds && new Set(selection.sourceIds);

  return sourceRegistrations
    .filter((source) => !sourceIds || sourceIds.has(source.id))
    .map((source) => {
      const roots = selection.roots?.get(source.id) ?? [];
      const requireExistingPath = selection.requireExistingRoots?.has(source.id) ?? false;

      if (!source.supportsSourceDir) {
        return source.create({ path: roots[0], requireExistingPath }, context);
      }

      return createDirectoryBackedAdapter(source, roots, requireExistingPath, context);
    });
}
