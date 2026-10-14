import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeUsdCost } from '../../domain/normalization.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { SourceId, UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { readJsonTranscriptFile } from '../read-json-file.js';
import {
  asTrimmedText,
  normalizeTimestampCandidate,
  toNumberLike,
  toTokenCount,
} from '../parsing-utils.js';
import type { SourceParseFileDiagnostics } from '../source-adapter.js';

type ClineParseContext = {
  sourceId: SourceId;
  sessionId: string;
  model: string | undefined;
  events: UsageEvent[];
  skippedRows: number;
  skippedRowReasons: Map<string, number>;
};

type ClineTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const ENVIRONMENT_DETAILS_OPEN_TAG = '<environment_details>';
const ENVIRONMENT_DETAILS_CLOSE_TAG = '</environment_details>';
const MODEL_OPEN_TAG = '<model>';
const MODEL_CLOSE_TAG = '</model>';

// Conversation history is untrusted, multi-megabyte text; lazy `[\s\S]*?` regexes over it
// go quadratic on repeated unclosed tags, so tagged blocks are found with indexOf scans.
function findLastTaggedBlock(
  content: string,
  openTag: string,
  closeTag: string,
): string | undefined {
  let lastBlock: string | undefined;
  let searchFrom = 0;

  for (;;) {
    const start = content.indexOf(openTag, searchFrom);

    if (start === -1) {
      return lastBlock;
    }

    const end = content.indexOf(closeTag, start + openTag.length);

    if (end === -1) {
      return lastBlock;
    }

    searchFrom = end + closeTag.length;
    lastBlock = content.slice(start, searchFrom);
  }
}

function findFirstTaggedText(
  content: string,
  openTag: string,
  closeTag: string,
): string | undefined {
  const start = content.indexOf(openTag);

  if (start === -1) {
    return undefined;
  }

  const end = content.indexOf(closeTag, start + openTag.length);
  return end === -1 ? undefined : content.slice(start + openTag.length, end);
}

function incrementContextSkippedReason(context: ClineParseContext, reason: string): void {
  context.skippedRows++;
  incrementSkippedReason(context.skippedRowReasons, reason);
}

function getTaskId(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

export function getClineTaskHistoryPath(uiMessagesPath: string): string {
  return path.join(path.dirname(uiMessagesPath), 'api_conversation_history.json');
}

// Roo Code (since PR #8954, 2025-10-31) and the Kilo Code extension write `tokensIn` as the
// cache-inclusive prompt count (input + cache writes + cache reads) next to the cache
// buckets, while Cline writes the provider's raw input count. Earlier Roo/Kilo rows carried
// the raw count too, which for Anthropic excludes cache tokens; an inclusive count is never
// smaller than the cache buckets, so only rows that can be inclusive are split.
const CACHE_INCLUSIVE_INPUT_SOURCE_IDS: ReadonlySet<string> = new Set(['roocode', 'kilocode']);

function resolveInputTokens(
  sourceId: SourceId,
  tokensIn: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  if (!CACHE_INCLUSIVE_INPUT_SOURCE_IDS.has(sourceId)) {
    return tokensIn;
  }

  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  return tokensIn >= cacheTokens ? tokensIn - cacheTokens : tokensIn;
}

function extractUsage(
  sourceId: SourceId,
  payload: Record<string, unknown>,
): {
  usage: ClineTokenUsage;
  costUsd: number | undefined;
  hasUsageSignal: boolean;
} {
  const cacheReadTokens = toTokenCount(payload.cacheReads);
  const cacheWriteTokens = toTokenCount(payload.cacheWrites);
  const usage = {
    inputTokens: resolveInputTokens(
      sourceId,
      toTokenCount(payload.tokensIn),
      cacheReadTokens,
      cacheWriteTokens,
    ),
    outputTokens: toTokenCount(payload.tokensOut),
    reasoningTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
  const costUsd = normalizeUsdCost(toNumberLike(payload.cost));
  const hasTokenSignal =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0;
  const hasCostSignal = costUsd !== undefined && costUsd > 0;

  return {
    usage,
    costUsd: hasCostSignal ? costUsd : undefined,
    hasUsageSignal: hasTokenSignal || hasCostSignal,
  };
}

function parsePayload(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = asTrimmedText(entry.text);

  if (!text) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function pushClineEvent(
  context: ClineParseContext,
  input: Omit<UsageEventInput, 'source' | 'sessionId'>,
): void {
  try {
    context.events.push(
      createUsageEvent({
        source: context.sourceId,
        sessionId: context.sessionId,
        ...input,
      }),
    );
  } catch {
    incrementContextSkippedReason(context, 'event_creation_failed');
  }
}

async function loadHistoryModel(historyPath: string): Promise<string | undefined> {
  let content: string;

  try {
    content = await readFile(historyPath, 'utf8');
  } catch {
    return undefined;
  }

  const lastEnvironmentDetails = findLastTaggedBlock(
    content,
    ENVIRONMENT_DETAILS_OPEN_TAG,
    ENVIRONMENT_DETAILS_CLOSE_TAG,
  );

  if (!lastEnvironmentDetails) {
    return undefined;
  }

  return asTrimmedText(
    findFirstTaggedText(lastEnvironmentDetails, MODEL_OPEN_TAG, MODEL_CLOSE_TAG),
  );
}

function isUsageEntry(entry: Record<string, unknown>): boolean {
  return entry.type === 'say' && entry.say === 'api_req_started';
}

function parseUsageEntry(context: ClineParseContext, entry: Record<string, unknown>): void {
  const payload = parsePayload(entry);

  if (!payload) {
    incrementContextSkippedReason(context, 'invalid_payload');
    return;
  }

  const { usage, costUsd, hasUsageSignal } = extractUsage(context.sourceId, payload);

  if (!hasUsageSignal) {
    incrementContextSkippedReason(context, 'no_token_usage');
    return;
  }

  const timestamp = normalizeTimestampCandidate(entry.ts);

  if (!timestamp) {
    incrementContextSkippedReason(context, 'invalid_timestamp');
    return;
  }

  const eventInput = {
    timestamp,
    provider: asTrimmedText(payload.apiProtocol),
    model: context.model,
    ...usage,
  };

  if (costUsd !== undefined) {
    pushClineEvent(context, {
      ...eventInput,
      costUsd,
    });
    return;
  }

  pushClineEvent(context, {
    ...eventInput,
    costMode: 'estimated',
  });
}

export async function parseClineTaskFile(
  sourceId: SourceId,
  filePath: string,
): Promise<SourceParseFileDiagnostics> {
  const context: ClineParseContext = {
    sourceId,
    sessionId: getTaskId(filePath),
    model: await loadHistoryModel(getClineTaskHistoryPath(filePath)),
    events: [],
    skippedRows: 0,
    skippedRowReasons: new Map(),
  };

  const parsed = await readJsonTranscriptFile(filePath);

  // A document of the wrong shape fails the file, like unreadable JSON, so its stored
  // events stay.
  if (!Array.isArray(parsed)) {
    throw new Error(`Task history is not a JSON array: ${filePath}`);
  }

  for (const entry of parsed) {
    const record = asRecord(entry);

    if (!record || !isUsageEntry(record)) {
      continue;
    }

    parseUsageEntry(context, record);
  }

  return toParseDiagnostics(context.events, context.skippedRows, context.skippedRowReasons);
}
