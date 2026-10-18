import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
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

/**
 * A V1 message's tokens are its last step's (its cost covers every step), so a message
 * with several steps takes the sum of its `step-finish` parts, in the message's shape.
 */
function readStepTokens(row: OpenCodeSqliteRow): Record<string, unknown> | undefined {
  if (toTokenCount(row.step_count) < 2) {
    return undefined;
  }

  return {
    input: row.step_input_tokens,
    output: row.step_output_tokens,
    reasoning: row.step_reasoning_tokens,
    cache: { read: row.step_cache_read_tokens, write: row.step_cache_write_tokens },
    total: row.step_total_tokens,
  };
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

/** Parses one message row; a skipped row is recorded in `diagnostics`. */
export function parseOpenCodeMessageRow(
  row: OpenCodeSqliteRow,
  sourceId: UsageEvent['source'],
  diagnostics: SourceReadDiagnostics,
): UsageEvent | undefined {
  const skipRow = (reason: SkippedRowReason): void => {
    recordSkippedRow(diagnostics, reason);
  };

  const dataJson = asTrimmedText(row.data_json);

  if (!dataJson) {
    skipRow('missing_data_json');
    return undefined;
  }

  let payload: Record<string, unknown>;

  try {
    const parsedPayload = asRecord(JSON.parse(dataJson));

    if (!parsedPayload) {
      skipRow('invalid_data_json');
      return undefined;
    }

    payload = parsedPayload;
  } catch {
    skipRow('invalid_data_json');
    return undefined;
  }

  // V2 rows (`session_message`) keep the role in the `type` column, not in the payload.
  const v2RowType = asTrimmedText(row.row_type);
  const role = v2RowType ?? asTrimmedText(payload.role) ?? asTrimmedText(payload.type);

  if (role?.toLowerCase() !== 'assistant') {
    return undefined;
  }

  const timestamp = resolveTimestamp(row.row_time, payload);

  if (!timestamp) {
    skipRow('missing_timestamp');
    return undefined;
  }

  const sessionId =
    normalizeSessionIdCandidate(row.row_session_id) ??
    normalizeSessionIdCandidate(payload.sessionID) ??
    normalizeSessionIdCandidate(payload.sessionId) ??
    normalizeSessionIdCandidate(payload.session_id) ??
    normalizeSessionIdCandidate(row.row_id);

  if (!sessionId) {
    skipRow('missing_session_id');
    return undefined;
  }

  // V2 nests the model: `{ id, providerID, variant }`.
  const modelPayload = asRecord(payload.model);
  const provider =
    asTrimmedText(payload.providerID) ??
    asTrimmedText(payload.provider) ??
    asTrimmedText(modelPayload?.providerID);
  const model =
    asTrimmedText(payload.modelID) ??
    asTrimmedText(payload.model) ??
    asTrimmedText(modelPayload?.id);
  const repoRoot = resolveRepoRoot(payload) ?? asTrimmedText(row.row_directory);
  const tokens = readStepTokens(row) ?? asRecord(payload.tokens);
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
    v2RowType === undefined &&
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
  const explicitCost = parseNonNegativeNumber(payload.cost);

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
      sessionId,
      timestamp,
      repoRoot,
      provider,
      model,
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
