import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText } from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import type { SourceParseFileDiagnostics } from '../source-adapter.js';

function resolveSessionId(filePath: string, sessionData: Record<string, unknown>): string {
  return asTrimmedText(sessionData.sessionId) ?? path.basename(filePath, '.json');
}

function normalizeEpochMsTimestamp(candidate: unknown): string | undefined {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    return undefined;
  }

  const date = new Date(candidate);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function extractFirstBaseUriPathFromResponse(response: unknown): string | undefined {
  if (!Array.isArray(response)) {
    return undefined;
  }

  for (const responseEntryRaw of response) {
    const responseEntry = asRecord(responseEntryRaw);

    if (!responseEntry) {
      continue;
    }

    const baseUri = asRecord(responseEntry.baseUri);
    const baseUriPath = asTrimmedText(baseUri?.path);

    if (baseUriPath) {
      return baseUriPath;
    }
  }

  return undefined;
}

function resolveSessionLevelRepoRootFallback(requests: unknown[]): string | undefined {
  for (const requestRaw of requests) {
    const request = asRecord(requestRaw);

    if (!request) {
      continue;
    }

    const baseUriPath = extractFirstBaseUriPathFromResponse(request.response);

    if (baseUriPath) {
      return baseUriPath;
    }
  }

  return undefined;
}

export function parseCopilotVscodeSession(
  filePath: string,
  content: string,
): SourceParseFileDiagnostics {
  const events: UsageEvent[] = [];
  let skippedRows = 0;
  const skippedRowReasons = new Map<string, number>();

  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    skippedRows++;
    incrementSkippedReason(skippedRowReasons, 'json_parse_error');
    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }

  const sessionData = asRecord(parsed);

  if (!sessionData) {
    skippedRows++;
    incrementSkippedReason(skippedRowReasons, 'invalid_session_data');
    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }

  if (!Array.isArray(sessionData.requests)) {
    skippedRows++;
    incrementSkippedReason(skippedRowReasons, 'invalid_requests_array');
    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }

  const sessionId = resolveSessionId(filePath, sessionData);
  const sessionLevelRepoRoot = resolveSessionLevelRepoRootFallback(sessionData.requests);

  for (const requestRaw of sessionData.requests) {
    const request = asRecord(requestRaw);

    if (!request) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_request');
      continue;
    }

    const timestamp = normalizeEpochMsTimestamp(request.timestamp);

    if (!timestamp) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
      continue;
    }

    const model = asTrimmedText(request.modelId);
    const requestRepoRoot = extractFirstBaseUriPathFromResponse(request.response);
    const repoRoot = requestRepoRoot ?? sessionLevelRepoRoot;

    try {
      events.push(
        createUsageEvent({
          source: 'copilot-vscode',
          sessionId,
          timestamp,
          repoRoot,
          provider: 'github',
          model,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costMode: 'estimated',
        }),
      );
    } catch {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
    }
  }

  return toParseDiagnostics(events, skippedRows, skippedRowReasons);
}
