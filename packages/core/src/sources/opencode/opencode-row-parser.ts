import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import {
  asTrimmedText,
  normalizeTimestampCandidate,
  resolveTotalTokens,
  toNumberLike,
  toTokenCount,
} from '../parsing-utils.js';
import { recordSkippedRow } from '../parse-diagnostics.js';
import type { SourceReadDiagnostics } from '../source-adapter.js';
import type { OpenCodeSqliteRow } from './opencode-sqlite-query.js';

type SkippedRowReason =
  | 'missing_data_json'
  | 'invalid_data_json'
  | 'missing_timestamp'
  | 'missing_session_id'
  | 'missing_usage_signal'
  | 'invalid_usage_event';

function resolveTimestamp(
  rowTimestamp: unknown,
  messagePayload: Record<string, unknown>,
): string | undefined {
  const timestampCandidates = [
    rowTimestamp,
    messagePayload.timestamp,
    messagePayload.timeCreated,
    messagePayload.time_created,
  ];

  for (const candidate of timestampCandidates) {
    const resolved = normalizeTimestampCandidate(candidate);

    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed = toNumberLike(value);

  if (parsed === undefined || parsed === null) {
    return undefined;
  }

  if (typeof parsed === 'string' && parsed.trim() === '') {
    return undefined;
  }

  const numberValue = typeof parsed === 'number' ? parsed : Number(parsed);

  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return undefined;
  }

  return numberValue;
}

function normalizeSessionIdCandidate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return asTrimmedText(value);
}

function resolveRepoRoot(messagePayload: Record<string, unknown>): string | undefined {
  const pathPayload = asRecord(messagePayload.path);

  return (
    asTrimmedText(pathPayload?.root) ??
    asTrimmedText(pathPayload?.cwd) ??
    asTrimmedText(messagePayload.cwd) ??
    asTrimmedText(messagePayload.repo_root) ??
    asTrimmedText(messagePayload.repoRoot) ??
    asTrimmedText(messagePayload.project_root) ??
    asTrimmedText(messagePayload.projectRoot)
  );
}

type MessageFields = {
  sessionId: string;
  repoRoot: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  isV2Row: boolean;
};

type Request = {
  timestamp: string;
  tokens: Record<string, unknown> | undefined;
  cost: unknown;
};

/**
 * A V1 message's tokens are its last step's while its cost covers every step, so a message
 * with several steps is read as one request per `step-finish` part, each with that step's
 * tokens and cost and the time the part was written. Undefined when the message is read as
 * one request; a step that does not parse is recorded and left out.
 */
function readStepRequests(
  row: OpenCodeSqliteRow,
  messageTimestamp: string,
  skipRow: (reason: SkippedRowReason) => void,
): Request[] | undefined {
  const stepPartsJson = asTrimmedText(row.step_parts_json);

  if (!stepPartsJson) {
    return undefined;
  }

  let stepParts: unknown;

  try {
    stepParts = JSON.parse(stepPartsJson);
  } catch {
    stepParts = undefined;
  }

  if (!Array.isArray(stepParts)) {
    skipRow('invalid_data_json');
    return [];
  }

  return (
    stepParts
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      // V1 part ids ascend in write order; `json_group_array` keeps no order.
      .sort((left, right) =>
        compareByCodePoint(asTrimmedText(left.id) ?? '', asTrimmedText(right.id) ?? ''),
      )
      .map((entry) => {
        const part = asRecord(entry.part);
        return {
          timestamp: normalizeTimestampCandidate(entry.time) ?? messageTimestamp,
          tokens: asRecord(part?.tokens),
          cost: part?.cost,
        };
      })
  );
}

function createRequestEvent(
  sourceId: UsageEvent['source'],
  fields: MessageFields,
  request: Request,
  skipRow: (reason: SkippedRowReason) => void,
): UsageEvent | undefined {
  const { tokens } = request;
  const tokenCache = asRecord(tokens?.cache);
  const inputTokens = toTokenCount(tokens?.input);
  const storedOutputTokens = toTokenCount(tokens?.output);
  const reasoningTokens = toTokenCount(tokens?.reasoning);
  const cacheReadTokens = toTokenCount(tokenCache?.read);
  const cacheWriteTokens = toTokenCount(tokenCache?.write);
  const declaredTotalTokens = toTokenCount(tokens?.total);
  // OpenCode stored `output` with reasoning included until April 2026 (#21047) and as
  // `outputTokens - reasoningTokens` since, while `total` (added February 2026) always comes
  // from the SDK and includes reasoning. A total equal to the stored buckets therefore marks
  // an inclusive row, and rows without a total predate the split (except Gemini rows, whose
  // SDK then reported thoughts outside output; those are only caught when output is smaller
  // than reasoning, which an inclusive row can never be). The domain contract counts
  // reasoning inside output, so only exclusive rows get it added back. V2 rows always store
  // visible output only, without a total.
  const outputIncludesReasoning =
    !fields.isV2Row &&
    storedOutputTokens >= reasoningTokens &&
    (declaredTotalTokens === 0 ||
      declaredTotalTokens ===
        inputTokens + storedOutputTokens + cacheReadTokens + cacheWriteTokens);
  const outputTokens = outputIncludesReasoning
    ? storedOutputTokens
    : storedOutputTokens + reasoningTokens;
  const totalTokens = resolveTotalTokens(
    declaredTotalTokens,
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  );
  const explicitCost = parseNonNegativeNumber(request.cost);

  if (
    !hasUsageSignal(
      [inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens],
      explicitCost,
    )
  ) {
    skipRow('missing_usage_signal');
    return undefined;
  }

  try {
    return createUsageEvent({
      source: sourceId,
      sessionId: fields.sessionId,
      timestamp: request.timestamp,
      repoRoot: fields.repoRoot,
      provider: fields.provider,
      model: fields.model,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd: explicitCost,
    });
  } catch {
    skipRow('invalid_usage_event');
    return undefined;
  }
}

function hasUsageSignal(usageFields: Array<unknown>, explicitCost: number | undefined): boolean {
  if (explicitCost !== undefined) {
    return true;
  }

  return usageFields.some((value) => {
    const parsed = parseNonNegativeNumber(value);
    return parsed !== undefined && parsed > 0;
  });
}

/**
 * Parses one message row into its requests: one, or one per step for a V1 message with
 * several steps. A skipped row or step is recorded in `diagnostics`.
 */
export function parseOpenCodeMessageRow(
  row: OpenCodeSqliteRow,
  sourceId: UsageEvent['source'],
  diagnostics: SourceReadDiagnostics,
): UsageEvent[] {
  const skipRow = (reason: SkippedRowReason): void => {
    recordSkippedRow(diagnostics, reason);
  };

  const dataJson = asTrimmedText(row.data_json);

  if (!dataJson) {
    skipRow('missing_data_json');
    return [];
  }

  let payload: Record<string, unknown>;

  try {
    const parsedPayload = asRecord(JSON.parse(dataJson));

    if (!parsedPayload) {
      skipRow('invalid_data_json');
      return [];
    }

    payload = parsedPayload;
  } catch {
    skipRow('invalid_data_json');
    return [];
  }

  // V2 rows (`session_message`) keep the role in the `type` column, not in the payload.
  const v2RowType = asTrimmedText(row.row_type);
  const role = v2RowType ?? asTrimmedText(payload.role) ?? asTrimmedText(payload.type);

  if (role?.toLowerCase() !== 'assistant') {
    return [];
  }

  const timestamp = resolveTimestamp(row.row_time, payload);

  if (!timestamp) {
    skipRow('missing_timestamp');
    return [];
  }

  const sessionId =
    normalizeSessionIdCandidate(row.row_session_id) ??
    normalizeSessionIdCandidate(payload.sessionID) ??
    normalizeSessionIdCandidate(payload.sessionId) ??
    normalizeSessionIdCandidate(payload.session_id) ??
    normalizeSessionIdCandidate(row.row_id);

  if (!sessionId) {
    skipRow('missing_session_id');
    return [];
  }

  // V2 nests the model: `{ id, providerID, variant }`.
  const modelPayload = asRecord(payload.model);
  const fields: MessageFields = {
    sessionId,
    repoRoot: resolveRepoRoot(payload) ?? asTrimmedText(row.row_directory),
    provider:
      asTrimmedText(payload.providerID) ??
      asTrimmedText(payload.provider) ??
      asTrimmedText(modelPayload?.providerID),
    model:
      asTrimmedText(payload.modelID) ??
      asTrimmedText(payload.model) ??
      asTrimmedText(modelPayload?.id),
    isV2Row: v2RowType !== undefined,
  };
  const requests = readStepRequests(row, timestamp, skipRow) ?? [
    { timestamp, tokens: asRecord(payload.tokens), cost: payload.cost },
  ];

  return requests.flatMap(
    (request) => createRequestEvent(sourceId, fields, request, skipRow) ?? [],
  );
}
