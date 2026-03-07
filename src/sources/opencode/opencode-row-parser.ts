import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
import type { SourceParseFileDiagnostics } from '../source-adapter.js';
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

function hasUsageSignal(usageFields: Array<unknown>, explicitCost: number | undefined): boolean {
  if (explicitCost !== undefined) {
    return true;
  }

  return usageFields.some((value) => {
    const parsed = parseNonNegativeNumber(value);
    return parsed !== undefined && parsed > 0;
  });
}

export function parseOpenCodeMessageRows(
  rows: Iterable<OpenCodeSqliteRow>,
  sourceId: UsageEvent['source'],
): SourceParseFileDiagnostics {
  const events: UsageEvent[] = [];
  let skippedRows = 0;
  const skippedRowReasons = new Map<SkippedRowReason, number>();

  const recordSkippedRow = (reason: SkippedRowReason): void => {
    skippedRows += 1;
    skippedRowReasons.set(reason, (skippedRowReasons.get(reason) ?? 0) + 1);
  };

  for (const row of rows) {
    const dataJson = asTrimmedText(row.data_json);

    if (!dataJson) {
      recordSkippedRow('missing_data_json');
      continue;
    }

    let payload: Record<string, unknown>;

    try {
      const parsedPayload = asRecord(JSON.parse(dataJson));

      if (!parsedPayload) {
        recordSkippedRow('invalid_data_json');
        continue;
      }

      payload = parsedPayload;
    } catch {
      recordSkippedRow('invalid_data_json');
      continue;
    }

    const role = asTrimmedText(payload.role) ?? asTrimmedText(payload.type);

    if (role?.toLowerCase() !== 'assistant') {
      continue;
    }

    const timestamp = resolveTimestamp(row.row_time, payload);

    if (!timestamp) {
      recordSkippedRow('missing_timestamp');
      continue;
    }

    const sessionId =
      normalizeSessionIdCandidate(row.row_session_id) ??
      normalizeSessionIdCandidate(payload.sessionID) ??
      normalizeSessionIdCandidate(payload.sessionId) ??
      normalizeSessionIdCandidate(payload.session_id) ??
      normalizeSessionIdCandidate(row.row_id);

    if (!sessionId) {
      recordSkippedRow('missing_session_id');
      continue;
    }

    const provider = asTrimmedText(payload.providerID) ?? asTrimmedText(payload.provider);
    const model = asTrimmedText(payload.modelID) ?? asTrimmedText(payload.model);
    const repoRoot = resolveRepoRoot(payload);
    const tokens = asRecord(payload.tokens);
    const tokenCache = asRecord(tokens?.cache);
    const inputTokens = toNumberLike(tokens?.input);
    const outputTokens = toNumberLike(tokens?.output);
    const reasoningTokens = toNumberLike(tokens?.reasoning);
    const cacheReadTokens = toNumberLike(tokenCache?.read);
    const cacheWriteTokens = toNumberLike(tokenCache?.write);
    const totalTokens = toNumberLike(tokens?.total);
    const explicitCost = parseNonNegativeNumber(payload.cost);

    if (
      !hasUsageSignal(
        [
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens,
        ],
        explicitCost,
      )
    ) {
      recordSkippedRow('missing_usage_signal');
      continue;
    }

    try {
      events.push(
        createUsageEvent({
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
          costMode: explicitCost === undefined ? 'estimated' : 'explicit',
        }),
      );
    } catch {
      recordSkippedRow('invalid_usage_event');
    }
  }

  return {
    events,
    skippedRows,
    skippedRowReasons: [...skippedRowReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => compareByCodePoint(left.reason, right.reason)),
  };
}
