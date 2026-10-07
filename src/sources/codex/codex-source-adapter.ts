import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  splitPromptIncludingCachedTokens,
  toNumberLike,
} from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

/** Codex keeps its state in CODEX_HOME (default ~/.codex); sessions live under it. */
export function resolveDefaultCodexSessionsDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(asTrimmedText(env.CODEX_HOME) ?? path.join(homeDir, '.codex'), 'sessions');
}

export const LEGACY_CODEX_MODEL_FALLBACK = 'legacy-codex-unknown';

type CodexUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/** A per-response `token_usage_record` row waiting for the `token_count` that covers it. */
type PendingUsageRecord = {
  timestamp: string;
  usage: CodexUsage;
  repoRoot?: string;
  model?: string;
};

type CodexSessionState = {
  sessionId: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
  previousTotalUsage?: CodexUsage;
  previousLastUsageOnlyKey?: string;
  pendingUsageRecords: PendingUsageRecord[];
  seenResponseIds: Set<string>;
};

export type CodexSourceAdapterOptions = SourceAdapterPathOptions & {
  env?: NodeJS.ProcessEnv;
};

const SESSION_META_BYTES = Buffer.from('"session_meta"');
const TURN_CONTEXT_BYTES = Buffer.from('"turn_context"');
const EVENT_MSG_BYTES = Buffer.from('"event_msg"');
const TOKEN_COUNT_BYTES = Buffer.from('"token_count"');
const TOKEN_USAGE_RECORD_BYTES = Buffer.from('"token_usage_record"');
const TYPE_FIELD_BYTES = Buffer.from('"type":"');
const SESSION_META_TYPE_BYTES = Buffer.from('session_meta"');
const TURN_CONTEXT_TYPE_BYTES = Buffer.from('turn_context"');
const TOKEN_USAGE_RECORD_TYPE_BYTES = Buffer.from('token_usage_record"');
const EVENT_MSG_TYPE_BYTES = Buffer.from('event_msg"');

function shouldParseCodexJsonlLineBytes(lineBytes: Buffer): boolean {
  const typeFieldIndex = lineBytes.indexOf(TYPE_FIELD_BYTES);

  if (typeFieldIndex !== -1) {
    const typeValueIndex = typeFieldIndex + TYPE_FIELD_BYTES.length;

    if (
      lineBytesIncludesAt(lineBytes, SESSION_META_TYPE_BYTES, typeValueIndex) ||
      lineBytesIncludesAt(lineBytes, TURN_CONTEXT_TYPE_BYTES, typeValueIndex) ||
      lineBytesIncludesAt(lineBytes, TOKEN_USAGE_RECORD_TYPE_BYTES, typeValueIndex)
    ) {
      return true;
    }

    if (lineBytesIncludesAt(lineBytes, EVENT_MSG_TYPE_BYTES, typeValueIndex)) {
      return lineBytes.includes(TOKEN_COUNT_BYTES, typeValueIndex);
    }

    return false;
  }

  if (
    lineBytes.includes(SESSION_META_BYTES) ||
    lineBytes.includes(TURN_CONTEXT_BYTES) ||
    lineBytes.includes(TOKEN_USAGE_RECORD_BYTES)
  ) {
    return true;
  }

  return lineBytes.includes(EVENT_MSG_BYTES) && lineBytes.includes(TOKEN_COUNT_BYTES);
}

function lineBytesIncludesAt(
  lineBytes: Buffer,
  expectedBytes: Buffer,
  startIndex: number,
): boolean {
  if (startIndex + expectedBytes.length > lineBytes.length) {
    return false;
  }

  for (let index = 0; index < expectedBytes.length; index += 1) {
    if (lineBytes[startIndex + index] !== expectedBytes[index]) {
      return false;
    }
  }

  return true;
}

function toUsage(value: unknown): CodexUsage | undefined {
  const usage = asRecord(value);

  if (!usage) {
    return undefined;
  }

  // Codex input_tokens includes cached_input_tokens. We store net input separately
  // to avoid double counting input + cache read in reports and estimated pricing.
  const { inputTokens, cacheReadTokens } = splitPromptIncludingCachedTokens(
    normalizeNonNegativeInteger(toNumberLike(usage.input_tokens)),
    normalizeNonNegativeInteger(toNumberLike(usage.cached_input_tokens)),
  );
  const cacheWriteTokens = normalizeNonNegativeInteger(
    toNumberLike(usage.cache_write_input_tokens),
  );
  const outputTokens = normalizeNonNegativeInteger(toNumberLike(usage.output_tokens));

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: normalizeNonNegativeInteger(toNumberLike(usage.reasoning_output_tokens)),
    // Match ccusage semantics: billable total excludes reasoning breakdown.
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function subtractUsage(current: CodexUsage, previous: CodexUsage): CodexUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

function addUsage(left: CodexUsage, right: CodexUsage): CodexUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function hasUsageSignal(usage: CodexUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.totalTokens > 0
  );
}

function hasUsageRollback(current: CodexUsage, previous: CodexUsage): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.cacheReadTokens < previous.cacheReadTokens ||
    current.cacheWriteTokens < previous.cacheWriteTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens ||
    current.totalTokens < previous.totalTokens
  );
}

function deriveDeltaUsage(
  info: Record<string, unknown>,
  previousTotalUsage: CodexUsage | undefined,
): {
  deltaUsage?: CodexUsage;
  latestTotalUsage?: CodexUsage;
  fromLastUsageOnly?: boolean;
} {
  const totalUsage = toUsage(info.total_token_usage);
  const lastUsage = toUsage(info.last_token_usage);

  if (totalUsage && previousTotalUsage) {
    if (hasUsageRollback(totalUsage, previousTotalUsage)) {
      if (lastUsage && hasUsageSignal(lastUsage)) {
        return { deltaUsage: lastUsage, latestTotalUsage: totalUsage };
      }

      return {
        deltaUsage: hasUsageSignal(totalUsage) ? totalUsage : undefined,
        latestTotalUsage: totalUsage,
      };
    }

    const deltaFromTotals = subtractUsage(totalUsage, previousTotalUsage);

    if (hasUsageSignal(deltaFromTotals)) {
      return { deltaUsage: deltaFromTotals, latestTotalUsage: totalUsage };
    }

    // Duplicate token_count rows can repeat the last per-turn usage while totals stay unchanged.
    // Prefer totals and treat unchanged totals as no new usage signal.
    return { latestTotalUsage: totalUsage };
  }

  if (lastUsage) {
    return { deltaUsage: lastUsage, latestTotalUsage: totalUsage, fromLastUsageOnly: true };
  }

  if (!totalUsage) {
    return {};
  }

  const deltaUsage = previousTotalUsage
    ? subtractUsage(totalUsage, previousTotalUsage)
    : totalUsage;

  return { deltaUsage, latestTotalUsage: totalUsage };
}

function createLastUsageOnlyKey(timestamp: string, usage: CodexUsage): string {
  return [
    timestamp,
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ].join(':');
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveRepoRootFromPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) {
    return undefined;
  }

  return (
    asTrimmedText(payload.cwd) ??
    asTrimmedText(payload.repo_root) ??
    asTrimmedText(payload.repoRoot) ??
    asTrimmedText(payload.project_root) ??
    asTrimmedText(payload.projectRoot)
  );
}

// Newer Codex writes one `token_usage_record` per API response before the cumulative
// `token_count` event. The cumulative totals never include the response that triggered an
// auto-compaction (the `token_count` after `compacted` repeats the previous totals), so the
// records are the authoritative per-response accounting whenever a file has them: each
// `token_count` delta releases the records collected since the previous one, and records
// still pending at the end of the file (a compaction summary, or a response whose
// `token_count` is not written yet) are emitted as well. Files without records keep the
// delta accounting.
function parseUsageRecord(
  line: Record<string, unknown>,
  state: CodexSessionState,
): { record?: PendingUsageRecord; invalidTimestamp?: boolean } {
  const payload = asRecord(line.payload);
  const usage = toUsage(payload?.usage);

  if (!usage || !hasUsageSignal(usage)) {
    return {};
  }

  const responseId = asTrimmedText(payload?.response_id);

  if (responseId && state.seenResponseIds.has(responseId)) {
    return {};
  }

  const timestamp = normalizeTimestampCandidate(line.timestamp);

  if (!timestamp) {
    return { invalidTimestamp: true };
  }

  if (responseId) {
    state.seenResponseIds.add(responseId);
  }

  return { record: { timestamp, usage, repoRoot: state.repoRoot, model: state.model } };
}

export class CodexSourceAdapter implements SourceAdapter {
  public readonly id = 'codex' as const;
  public readonly parserVersion = 2;
  public readonly capabilities = {
    fixedProviderRoots: ['openai'],
    eventsPrecedeFileMtime: true,
  } as const;

  private readonly sessionsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: CodexSourceAdapterOptions = {}) {
    this.sessionsDir = options.dir ?? resolveDefaultCodexSessionsDir(options.env);
    this.requireDir = options.requireDir ?? false;
  }

  public getSearchPaths(): string[] {
    return [this.sessionsDir].map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    if (isBlankText(this.sessionsDir)) {
      throw new Error('Codex sessions directory must be a non-empty path');
    }

    const normalizedSessionsDir = this.sessionsDir.trim();

    if (this.requireDir) {
      const sessionsDirStats = await pathStat(normalizedSessionsDir);

      if (!sessionsDirStats) {
        throw new Error(
          `Codex sessions directory is missing or unreadable: ${normalizedSessionsDir}`,
        );
      }

      if (!sessionsDirStats.isDirectory()) {
        throw new Error(`Codex sessions directory is not a directory: ${normalizedSessionsDir}`);
      }
    }

    return discoverJsonlFiles(normalizedSessionsDir);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();

    const state: CodexSessionState = {
      sessionId: getFallbackSessionId(filePath),
      provider: 'openai',
      pendingUsageRecords: [],
      seenResponseIds: new Set(),
    };

    const pushEvent = (record: PendingUsageRecord): void => {
      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp: record.timestamp,
            repoRoot: record.repoRoot,
            provider: state.provider,
            model: record.model ?? LEGACY_CODEX_MODEL_FALLBACK,
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            reasoningTokens: record.usage.reasoningTokens,
            cacheReadTokens: record.usage.cacheReadTokens,
            cacheWriteTokens: record.usage.cacheWriteTokens,
            totalTokens: record.usage.totalTokens,
            costMode: 'estimated',
          }),
        );
      } catch {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
      }
    };

    const flushPendingUsageRecords = (): void => {
      for (const record of state.pendingUsageRecords) {
        pushEvent(record);
      }

      state.pendingUsageRecords = [];
    };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLineBytes: shouldParseCodexJsonlLineBytes,
      onMalformedLine: () => {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      },
    })) {
      if (line.type === 'session_meta') {
        const payload = asRecord(line.payload);
        state.sessionId = asTrimmedText(payload?.id) ?? state.sessionId;
        state.provider = asTrimmedText(payload?.model_provider) ?? state.provider;
        state.repoRoot = resolveRepoRootFromPayload(payload) ?? state.repoRoot;
        continue;
      }

      if (line.type === 'turn_context') {
        const payload = asRecord(line.payload);
        state.model = asTrimmedText(payload?.model) ?? state.model;
        state.repoRoot = resolveRepoRootFromPayload(payload) ?? state.repoRoot;
        continue;
      }

      if (line.type === 'token_usage_record') {
        const { record, invalidTimestamp } = parseUsageRecord(line, state);

        if (record) {
          state.pendingUsageRecords.push(record);
        } else if (invalidTimestamp) {
          skippedRows++;
          incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        }

        continue;
      }

      if (line.type !== 'event_msg') {
        continue;
      }

      const payload = asRecord(line.payload);

      if (payload?.type !== 'token_count') {
        continue;
      }

      const info = asRecord(payload.info);

      if (!info) {
        continue;
      }

      const { deltaUsage, latestTotalUsage, fromLastUsageOnly } = deriveDeltaUsage(
        info,
        state.previousTotalUsage,
      );

      if (!deltaUsage || !hasUsageSignal(deltaUsage)) {
        if (!fromLastUsageOnly) {
          state.previousLastUsageOnlyKey = undefined;
        }

        state.previousTotalUsage = latestTotalUsage ?? state.previousTotalUsage;
        continue;
      }

      const timestamp = normalizeTimestampCandidate(line.timestamp);

      if (!timestamp) {
        if (!fromLastUsageOnly) {
          state.previousLastUsageOnlyKey = undefined;
        }

        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      if (fromLastUsageOnly) {
        const currentLastUsageOnlyKey = createLastUsageOnlyKey(timestamp, deltaUsage);

        if (state.previousLastUsageOnlyKey === currentLastUsageOnlyKey) {
          continue;
        }

        state.previousLastUsageOnlyKey = currentLastUsageOnlyKey;
      } else {
        state.previousLastUsageOnlyKey = undefined;
      }

      if (state.pendingUsageRecords.length > 0) {
        flushPendingUsageRecords();
      } else {
        pushEvent({
          timestamp,
          usage: deltaUsage,
          repoRoot: state.repoRoot,
          model: state.model,
        });
      }

      if (latestTotalUsage) {
        state.previousTotalUsage = latestTotalUsage;
      } else if (state.previousTotalUsage) {
        state.previousTotalUsage = addUsage(state.previousTotalUsage, deltaUsage);
      } else {
        state.previousTotalUsage = deltaUsage;
      }
    }

    flushPendingUsageRecords();

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

/** The sessions directory under ~/.codex, ignoring CODEX_HOME. */
export function getDefaultCodexSessionsDir(): string {
  return resolveDefaultCodexSessionsDir({});
}
