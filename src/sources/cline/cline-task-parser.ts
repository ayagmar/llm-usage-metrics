import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeNonNegativeInteger, normalizeUsdCost } from '../../domain/normalization.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { SourceId, UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
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

const ENVIRONMENT_DETAILS_PATTERN = /<environment_details>[\s\S]*?<\/environment_details>/gu;
const MODEL_PATTERN = /<model>([\s\S]*?)<\/model>/u;

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

function toTokenCount(value: unknown): number {
  return normalizeNonNegativeInteger(toNumberLike(value));
}

function extractUsage(payload: Record<string, unknown>): {
  usage: ClineTokenUsage;
  costUsd: number | undefined;
  hasUsageSignal: boolean;
} {
  const usage = {
    inputTokens: toTokenCount(payload.tokensIn),
    outputTokens: toTokenCount(payload.tokensOut),
    reasoningTokens: 0,
    cacheReadTokens: toTokenCount(payload.cacheReads),
    cacheWriteTokens: toTokenCount(payload.cacheWrites),
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

  const lastEnvironmentDetails = [...content.matchAll(ENVIRONMENT_DETAILS_PATTERN)]
    .map((match) => match[0])
    .at(-1);

  if (!lastEnvironmentDetails) {
    return undefined;
  }

  const modelMatch = MODEL_PATTERN.exec(lastEnvironmentDetails);
  return asTrimmedText(modelMatch?.[1]);
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

  const { usage, costUsd, hasUsageSignal } = extractUsage(payload);

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

  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    incrementContextSkippedReason(context, 'json_parse_error');
    return toParseDiagnostics(context.events, context.skippedRows, context.skippedRowReasons);
  }

  if (!Array.isArray(parsed)) {
    incrementContextSkippedReason(context, 'invalid_messages_data');
    return toParseDiagnostics(context.events, context.skippedRows, context.skippedRowReasons);
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
