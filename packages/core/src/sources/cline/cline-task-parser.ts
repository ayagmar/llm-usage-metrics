import path from 'node:path';

import { normalizeUsdCost } from '../../domain/normalization.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { SourceId, UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { readJsonArrayElements } from '../../utils/read-json-array-elements.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  normalizeTimestampCandidate,
  toNumberLike,
  toTokenCount,
} from '../parsing-utils.js';
import type { SourceReadDiagnostics, SourceReadOptions } from '../source-adapter.js';
import { loadHistoryModel } from './cline-history-model.js';

type ClineParseContext = {
  sourceId: SourceId;
  sessionId: string;
  model: string | undefined;
  diagnostics: SourceReadDiagnostics;
};

type ClineTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

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

function createClineEvent(
  context: ClineParseContext,
  input: Omit<UsageEventInput, 'source' | 'sessionId'>,
): UsageEvent | undefined {
  try {
    return createUsageEvent({
      source: context.sourceId,
      sessionId: context.sessionId,
      ...input,
    });
  } catch {
    recordSkippedRow(context.diagnostics, 'event_creation_failed');
    return undefined;
  }
}

function isUsageEntry(entry: Record<string, unknown>): boolean {
  return entry.type === 'say' && entry.say === 'api_req_started';
}

function parseUsageEntry(
  context: ClineParseContext,
  entry: Record<string, unknown>,
): UsageEvent | undefined {
  const payload = parsePayload(entry);

  if (!payload) {
    recordSkippedRow(context.diagnostics, 'invalid_payload');
    return undefined;
  }

  const { usage, costUsd, hasUsageSignal } = extractUsage(context.sourceId, payload);

  if (!hasUsageSignal) {
    recordSkippedRow(context.diagnostics, 'no_token_usage');
    return undefined;
  }

  const timestamp = normalizeTimestampCandidate(entry.ts);

  if (!timestamp) {
    recordSkippedRow(context.diagnostics, 'invalid_timestamp');
    return undefined;
  }

  const eventInput = {
    timestamp,
    provider: asTrimmedText(payload.apiProtocol),
    model: context.model,
    ...usage,
  };

  if (costUsd !== undefined) {
    return createClineEvent(context, {
      ...eventInput,
      costUsd,
    });
  }

  return createClineEvent(context, {
    ...eventInput,
  });
}

export async function* readClineTaskFile(
  sourceId: SourceId,
  filePath: string,
  options: SourceReadOptions = {},
): AsyncGenerator<UsageEvent, void, undefined> {
  const context: ClineParseContext = {
    sourceId,
    sessionId: getTaskId(filePath),
    model: await loadHistoryModel(getClineTaskHistoryPath(filePath)),
    diagnostics: options.diagnostics ?? createReadDiagnostics(),
  };

  // A document of the wrong shape fails the file, like unreadable JSON, so its stored
  // events stay.
  const entries = readJsonArrayElements(filePath, {
    notArrayMessage: `Task history is not a JSON array: ${filePath}`,
  });

  for await (const entry of entries) {
    const record = asRecord(entry);

    if (!record || !isUsageEntry(record)) {
      continue;
    }

    const event = parseUsageEntry(context, record);

    if (event) {
      yield event;
    }
  }
}
