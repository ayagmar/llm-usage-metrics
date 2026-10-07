import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import type { NumberLike } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, hasPositiveUsageOrCostSignal, toNumberLike } from '../parsing-utils.js';
import { DshSessionLogUnreadableError, readDshSessionLog } from './dsh-session-log-reader.js';
import type { DshSessionLogRead } from './dsh-session-log-reader.js';
import { getDefaultDshSessionsDir } from './dsh-path-resolver.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

/**
 * Committed session log names the harness writes: `session.jsonl` for format
 * generation zero and `session.vN.jsonl` for later generations, optionally
 * zstd-compressed. Temporary, uppercase, and leading-zero names are not
 * canonical.
 */
const DSH_SESSION_LOG_FILENAME_PATTERN = /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/u;

const DSH_ASSISTANT_MESSAGE_LINE_PATTERN = /"type"\s*:\s*"assistant\/message"/u;
const DSH_SESSION_LINE_PATTERN = /"type"\s*:\s*"session"/u;
const DSH_TITLE_REQUEST_LINE_PATTERN = /"type"\s*:\s*"session\/title-llm-request"/u;

type DshSessionState = {
  sessionId: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

type DshUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
};

export type DshSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default root scanned when no dir override is given. */
  defaultRootDirs?: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function shouldParseDshJsonlLine(lineText: string): boolean {
  return (
    DSH_ASSISTANT_MESSAGE_LINE_PATTERN.test(lineText) ||
    DSH_SESSION_LINE_PATTERN.test(lineText) ||
    DSH_TITLE_REQUEST_LINE_PATTERN.test(lineText)
  );
}

function isDshSessionLogFile(fileName: string): boolean {
  return DSH_SESSION_LOG_FILENAME_PATTERN.test(fileName);
}

/**
 * Session directories are named `session-<uuid>`; fall back to the log path so
 * a session whose header event is unreadable still yields distinct events.
 */
function getFallbackSessionId(filePath: string): string {
  const parentDirName = path.basename(path.dirname(filePath));

  if (parentDirName.startsWith('session-')) {
    return parentDirName;
  }

  return path.basename(filePath).replace(/\.zstd$/u, '');
}

function resolveRoute(record: Record<string, unknown> | undefined): {
  provider?: string;
  model?: string;
} {
  const route = asRecord(record?.route) ?? record;

  return {
    provider: asTrimmedText(route?.provider),
    model: asTrimmedText(route?.model),
  };
}

/**
 * DSH reports `inputTokens` already excluding the cached prefix, so the
 * buckets map one-to-one onto the domain contract. `reasoningTokens` is a
 * subset of `outputTokens` and is carried for reporting only.
 */
function extractUsage(usage: Record<string, unknown>): DshUsageExtract | undefined {
  const extracted: DshUsageExtract = {
    inputTokens: toNumberLike(usage.inputTokens),
    outputTokens: toNumberLike(usage.outputTokens),
    reasoningTokens: toNumberLike(usage.reasoningTokens),
    cacheReadTokens: toNumberLike(usage.cacheReadTokens),
    cacheWriteTokens: toNumberLike(usage.cacheWriteTokens),
    totalTokens: toNumberLike(usage.totalTokens),
  };

  const usageCandidates = [
    extracted.inputTokens,
    extracted.outputTokens,
    extracted.reasoningTokens,
    extracted.cacheReadTokens,
    extracted.cacheWriteTokens,
    extracted.totalTokens,
  ];

  return hasPositiveUsageOrCostSignal(usageCandidates, undefined) ? extracted : undefined;
}

function resolveTimestamp(line: Record<string, unknown>): string | undefined {
  const time = line.time;

  if (typeof time !== 'number' || !Number.isFinite(time)) {
    return undefined;
  }

  const date = new Date(time);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export class DshSourceAdapter implements SourceAdapter {
  public readonly id = 'dsh' as const;
  public readonly capabilities = { eventsPrecedeFileMtime: true } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: DshSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ?? [
        getDefaultDshSessionsDir({ env: options.env, homeDir: options.homeDir }),
      ],
    );
    this.requireDir = options.requireDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireDir,
      directoryLabel: 'DSH sessions directory',
      sortAcrossRoots: true,
      discoverInRoot: async (rootDir) => {
        const discovered = [
          ...(await discoverFiles(rootDir, { extension: '.jsonl' })),
          ...(await discoverFiles(rootDir, { extension: '.jsonl.zstd' })),
        ];

        return discovered.filter((filePath) => isDshSessionLogFile(path.basename(filePath)));
      },
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    const skippedRowReasons = new Map<string, number>();
    const state: DshSessionState = { sessionId: getFallbackSessionId(filePath) };
    let skippedRows = 0;

    let log: DshSessionLogRead;

    try {
      log = await readDshSessionLog(filePath);
    } catch (error) {
      if (error instanceof DshSessionLogUnreadableError) {
        return toParseDiagnostics(events, 1, new Map([['file_parse_failed', 1]]));
      }

      throw error;
    }

    for (const reasonStat of log.skippedRowReasons) {
      incrementSkippedReason(skippedRowReasons, reasonStat.reason);
      skippedRows += reasonStat.count;
    }

    for (const lineText of log.lines) {
      if (!shouldParseDshJsonlLine(lineText)) {
        continue;
      }

      let line: Record<string, unknown>;

      try {
        const parsedLine = asRecord(JSON.parse(lineText));

        if (!parsedLine) {
          continue;
        }

        line = parsedLine;
      } catch {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'json_parse_error');
        continue;
      }

      if (line.type === 'session') {
        state.sessionId = asTrimmedText(line.id) ?? state.sessionId;
        state.repoRoot = asTrimmedText(line.cwd) ?? state.repoRoot;
        continue;
      }

      if (line.type === 'session/title-llm-request') {
        const route = resolveRoute(asRecord(line.data));
        state.provider = route.provider ?? state.provider;
        state.model = route.model ?? state.model;
        continue;
      }

      if (line.type !== 'assistant/message') {
        continue;
      }

      const data = asRecord(line.data);
      const message = asRecord(data?.message);
      const usage = asRecord(data?.usage);

      if (!usage) {
        continue;
      }

      const extractedUsage = extractUsage(usage);

      if (!extractedUsage) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'no_token_usage');
        continue;
      }

      const timestamp = resolveTimestamp(line);

      if (!timestamp || !state.sessionId) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      const source = asRecord(message?.source);
      const provider = asTrimmedText(source?.provider) ?? state.provider;
      const model = asTrimmedText(source?.model) ?? state.model;

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp,
            repoRoot: state.repoRoot,
            provider,
            model,
            ...extractedUsage,
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

export { getDefaultDshSessionsDir };
