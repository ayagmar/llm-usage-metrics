import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import type { NumberLike } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathExists } from '../../utils/fs-helpers.js';
import { readFirstLine } from '../../utils/read-first-line.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import {
  discoverFilesAcrossRoots,
  isPathWithinRoots,
  resolveRootDirs,
} from '../multi-root-discovery.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  hasPositiveUsageOrCostSignal,
  normalizeTimestampCandidate,
  toNumberLike,
} from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

const defaultSessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const defaultPiRootDirs = [
  defaultSessionsDir,
  path.join(os.homedir(), '.omp', 'agent', 'sessions'),
];

type PiSessionState = {
  sessionId?: string;
  sessionTimestamp?: string;
  /** Set for forked sessions: entries before this instant were copied from the parent. */
  forkedAtMs?: number;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

type PiUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
  costUsd?: NumberLike;
};

export type PiSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
};

const PI_MESSAGE_LINE_PATTERN = /"type"\s*:\s*"message"/u;
const PI_SESSION_LINE_PATTERN = /"type"\s*:\s*"session"/u;
const PI_MODEL_CHANGE_LINE_PATTERN = /"type"\s*:\s*"model_change"/u;

function shouldParsePiJsonlLine(lineText: string): boolean {
  return (
    PI_MESSAGE_LINE_PATTERN.test(lineText) ||
    PI_SESSION_LINE_PATTERN.test(lineText) ||
    PI_MODEL_CHANGE_LINE_PATTERN.test(lineText)
  );
}

function resolveTimestamp(
  line: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  state: PiSessionState,
): string | undefined {
  const candidates = [line.timestamp, message?.timestamp, state.sessionTimestamp];

  for (const candidate of candidates) {
    const normalizedTimestamp = normalizeTimestampCandidate(candidate);

    if (normalizedTimestamp) {
      return normalizedTimestamp;
    }
  }

  return undefined;
}

function resolveParentSessionPath(
  sessionLine: Record<string, unknown>,
  filePath: string,
): string | undefined {
  const parentSession = asTrimmedText(sessionLine.parentSession);
  return parentSession ? path.resolve(path.dirname(filePath), parentSession) : undefined;
}

async function readParentSessionPath(filePath: string): Promise<string | undefined> {
  // pi writes the session header as the first line; reading only that line keeps the
  // per-file cache-key check cheap on warm runs.
  const firstLine = await readFirstLine(filePath);

  if (!firstLine?.includes('"parentSession"')) {
    return undefined;
  }

  try {
    const header = asRecord(JSON.parse(firstLine));
    return header?.type === 'session' ? resolveParentSessionPath(header, filePath) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entries of a forked session older than its header were copied from the parent. They
 * are skipped only while the same report counts the parent (it exists and lies under a
 * discovery root); otherwise the fork's copies are the only counted record of that usage.
 */
async function resolveForkedAtMs(
  sessionLine: Record<string, unknown>,
  filePath: string,
  rootDirs: readonly string[],
): Promise<number | undefined> {
  const parentSessionPath = resolveParentSessionPath(sessionLine, filePath);

  if (
    !parentSessionPath ||
    !isPathWithinRoots(parentSessionPath, rootDirs) ||
    !(await pathExists(parentSessionPath))
  ) {
    return undefined;
  }

  const timestamp = normalizeTimestampCandidate(sessionLine.timestamp);
  return timestamp ? Date.parse(timestamp) : undefined;
}

function extractUsageFromRecord(usage: Record<string, unknown>): PiUsageExtract | undefined {
  const cost = asRecord(usage.cost);

  const extracted: PiUsageExtract = {
    inputTokens: toNumberLike(usage.input),
    outputTokens: toNumberLike(usage.output),
    reasoningTokens: toNumberLike(
      usage.reasoning ?? usage.reasoningTokens ?? usage.reasoningOutput ?? usage.outputReasoning,
    ),
    cacheReadTokens: toNumberLike(usage.cacheRead),
    cacheWriteTokens: toNumberLike(usage.cacheWrite),
    totalTokens: toNumberLike(usage.totalTokens),
    costUsd: toNumberLike(cost?.total),
  };

  const usageCandidates = [
    extracted.inputTokens,
    extracted.outputTokens,
    extracted.reasoningTokens,
    extracted.cacheReadTokens,
    extracted.cacheWriteTokens,
    extracted.totalTokens,
  ];

  return hasPositiveUsageOrCostSignal(usageCandidates, extracted.costUsd) ? extracted : undefined;
}

function extractUsage(line: Record<string, unknown>, message: Record<string, unknown> | undefined) {
  const lineUsage = asRecord(line.usage);
  const messageUsage = asRecord(message?.usage);

  if (lineUsage) {
    const extractedLineUsage = extractUsageFromRecord(lineUsage);

    if (extractedLineUsage) {
      return extractedLineUsage;
    }
  }

  if (!messageUsage) {
    return undefined;
  }

  return extractUsageFromRecord(messageUsage);
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveRepoRootFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }

  const pathRecord = asRecord(record.path);

  return (
    asTrimmedText(pathRecord?.root) ??
    asTrimmedText(pathRecord?.cwd) ??
    asTrimmedText(record.cwd) ??
    asTrimmedText(record.repo_root) ??
    asTrimmedText(record.repoRoot) ??
    asTrimmedText(record.project_root) ??
    asTrimmedText(record.projectRoot)
  );
}

export class PiSourceAdapter implements SourceAdapter {
  public readonly id = 'pi' as const;
  public readonly parserVersion = 3;
  public readonly capabilities = { eventsPrecedeFileMtime: true } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: PiSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(options.dir, options.defaultRootDirs ?? defaultPiRootDirs);
    this.requireDir = options.requireDir ?? false;
  }

  public getSearchPaths(): string[] {
    return this.rootDirs.map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireDir,
      directoryLabel: 'PI sessions directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    // Only a parent this adapter can discover changes the parse result (see
    // resolveForkedAtMs), so the dependency also keys the cache on that decision.
    const parentSessionPath = await readParentSessionPath(filePath);
    return parentSessionPath && isPathWithinRoots(parentSessionPath, this.rootDirs)
      ? [parentSessionPath]
      : [];
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();
    const state: PiSessionState = { sessionId: getFallbackSessionId(filePath) };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParsePiJsonlLine,
      onMalformedLine: () => {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      },
    })) {
      if (line.type === 'session') {
        state.sessionId = asTrimmedText(line.id) ?? state.sessionId;
        state.sessionTimestamp = asTrimmedText(line.timestamp) ?? state.sessionTimestamp;
        state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
        state.forkedAtMs =
          (await resolveForkedAtMs(line, filePath, this.rootDirs)) ?? state.forkedAtMs;
        continue;
      }

      if (line.type === 'model_change') {
        state.provider = asTrimmedText(line.provider) ?? state.provider;
        state.model = asTrimmedText(line.modelId) ?? asTrimmedText(line.model) ?? state.model;
        state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
        continue;
      }

      if (line.type !== 'message') {
        continue;
      }

      const message = asRecord(line.message);
      const usage = extractUsage(line, message);

      if (!usage) {
        const hasUsageRecord = Boolean(asRecord(line.usage) ?? asRecord(message?.usage));

        if (hasUsageRecord) {
          skippedRows++;
          incrementSkippedReason(skippedRowReasons, 'no_token_usage');
        }

        continue;
      }

      const provider =
        asTrimmedText(line.provider) ?? asTrimmedText(message?.provider) ?? state.provider;

      const timestamp = resolveTimestamp(line, message, state);

      if (!timestamp || !state.sessionId) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      // A fork copies the parent's entries (same ids and timestamps) ahead of its own;
      // the parent session file already counts them.
      if (state.forkedAtMs !== undefined && Date.parse(timestamp) < state.forkedAtMs) {
        continue;
      }

      const model =
        asTrimmedText(line.model) ??
        asTrimmedText(line.modelId) ??
        asTrimmedText(message?.model) ??
        state.model;
      const repoRoot =
        resolveRepoRootFromRecord(line) ?? resolveRepoRootFromRecord(message) ?? state.repoRoot;

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp,
            repoRoot,
            provider,
            model,
            ...usage,
          }),
        );
      } catch {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
        continue;
      }
    }

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

export function getDefaultPiSessionsDir(): string {
  return defaultSessionsDir;
}
