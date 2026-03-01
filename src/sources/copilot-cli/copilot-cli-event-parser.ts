import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText } from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import type { SourceParseFileDiagnostics } from '../source-adapter.js';
import type { CopilotCliWorkspaceMetadata } from './copilot-cli-workspace-yaml.js';

const COPILOT_CLI_EVENT_LINE_PATTERN =
  /"type"\s*:\s*"(session\.start|session\.model_change|user\.message|assistant\.turn_end|session\.truncation)"/u;

type CopilotCliParserState = {
  sessionId: string;
  repoRoot?: string;
  model?: string;
  pendingUserTimestamps: string[];
};

function shouldParseCopilotCliLine(lineText: string): boolean {
  return COPILOT_CLI_EVENT_LINE_PATTERN.test(lineText);
}

function normalizeTimestampCandidate(candidate: unknown): string | undefined {
  const text = asTrimmedText(candidate);

  if (!text) {
    return undefined;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function getFallbackSessionId(filePath: string): string {
  if (path.basename(filePath) === 'events.jsonl') {
    return path.basename(path.dirname(filePath));
  }

  return path.basename(filePath, '.jsonl');
}

function resolveInitialSessionId(
  filePath: string,
  workspaceMetadata: CopilotCliWorkspaceMetadata,
): string {
  return workspaceMetadata.id?.trim() || getFallbackSessionId(filePath);
}

function resolveInitialRepoRoot(workspaceMetadata: CopilotCliWorkspaceMetadata): string | undefined {
  const cwd = workspaceMetadata.cwd?.trim();
  return cwd || undefined;
}

export function parseCopilotCliEvents(
  filePath: string,
  content: string,
  workspaceMetadata: CopilotCliWorkspaceMetadata = {},
): SourceParseFileDiagnostics<UsageEvent> {
  const events: UsageEvent[] = [];
  let skippedRows = 0;
  const skippedRowReasons = new Map<string, number>();

  const state: CopilotCliParserState = {
    sessionId: resolveInitialSessionId(filePath, workspaceMetadata),
    repoRoot: resolveInitialRepoRoot(workspaceMetadata),
    pendingUserTimestamps: [],
  };

  for (const rawLine of content.split(/\r?\n/u)) {
    const lineText = rawLine.trim();

    if (!lineText || !shouldParseCopilotCliLine(lineText)) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(lineText) as unknown;
    } catch {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      continue;
    }

    const line = asRecord(parsed);

    if (!line) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_record');
      continue;
    }

    const eventType = asTrimmedText(line.type);

    if (!eventType) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_record');
      continue;
    }

    if (eventType === 'session.start') {
      const data = asRecord(line.data);
      const context = asRecord(data?.context);

      state.sessionId = asTrimmedText(data?.sessionId) ?? state.sessionId;
      state.repoRoot = asTrimmedText(context?.cwd) ?? state.repoRoot;
      continue;
    }

    if (eventType === 'session.model_change') {
      const data = asRecord(line.data);
      state.model = asTrimmedText(data?.model) ?? state.model;
      continue;
    }

    if (eventType === 'user.message') {
      const timestamp = normalizeTimestampCandidate(line.timestamp);

      if (!timestamp) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      state.pendingUserTimestamps.push(timestamp);
      continue;
    }

    if (eventType === 'session.truncation') {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'unsupported_event_type');
      continue;
    }

    if (eventType !== 'assistant.turn_end') {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'unsupported_event_type');
      continue;
    }

    const queuedTimestamp = state.pendingUserTimestamps.shift();
    const assistantTimestamp = normalizeTimestampCandidate(line.timestamp);
    const timestamp = queuedTimestamp ?? assistantTimestamp;

    if (!timestamp) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'missing_timestamp');
      continue;
    }

    try {
      events.push(
        createUsageEvent({
          source: 'copilot-cli',
          sessionId: state.sessionId,
          timestamp,
          repoRoot: state.repoRoot,
          provider: 'github',
          model: state.model,
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
