import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText } from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import type { SourceParseFileDiagnostics } from '../source-adapter.js';

const COPILOT_VSCODE_ESTIMATED_CHARS_PER_TOKEN = 4;

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

function estimateTokensFromText(text: string | undefined): number {
  if (!text) {
    return 0;
  }

  const normalized = text.trim();

  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / COPILOT_VSCODE_ESTIMATED_CHARS_PER_TOKEN));
}

function extractRequestMessageText(request: Record<string, unknown>): string | undefined {
  const message = asRecord(request.message);

  if (!message) {
    return undefined;
  }

  const directText = asTrimmedText(message.text);

  if (directText) {
    return directText;
  }

  if (!Array.isArray(message.parts)) {
    return undefined;
  }

  const partTexts: string[] = [];

  for (const partRaw of message.parts) {
    const part = asRecord(partRaw);
    const partText = asTrimmedText(part?.text);

    if (partText) {
      partTexts.push(partText);
    }
  }

  return partTexts.length > 0 ? partTexts.join('\n') : undefined;
}

function extractResponseValueText(response: unknown): {
  outputText: string | undefined;
  reasoningText: string | undefined;
} {
  if (!Array.isArray(response)) {
    return {
      outputText: undefined,
      reasoningText: undefined,
    };
  }

  const outputParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const responseEntryRaw of response) {
    const responseEntry = asRecord(responseEntryRaw);

    if (!responseEntry) {
      continue;
    }

    const valueText = asTrimmedText(responseEntry.value);

    if (!valueText) {
      continue;
    }

    const kind = asTrimmedText(responseEntry.kind);

    if (kind === 'thinking') {
      reasoningParts.push(valueText);
      continue;
    }

    if (!kind) {
      outputParts.push(valueText);
    }
  }

  return {
    outputText: outputParts.length > 0 ? outputParts.join('\n') : undefined,
    reasoningText: reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined,
  };
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
    const inputTokens = estimateTokensFromText(extractRequestMessageText(request));
    const { outputText, reasoningText } = extractResponseValueText(request.response);
    const outputTokens = estimateTokensFromText(outputText);
    const reasoningTokens = estimateTokensFromText(reasoningText);

    try {
      events.push(
        createUsageEvent({
          source: 'copilot-vscode',
          sessionId,
          timestamp,
          repoRoot,
          provider: 'github',
          model,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: inputTokens + outputTokens + reasoningTokens,
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
