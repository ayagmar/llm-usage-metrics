import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import { createUsageEvent, type UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathIsDirectory, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, isBlankText, normalizeTimestampCandidate } from '../parsing-utils.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';

const defaultOtelDir = path.join(os.homedir(), '.copilot', 'otel');
type CopilotCandidate = {
  priority: number;
  lineIndex: number;
  timestamp: string | undefined;
  sessionId: string;
  traceId: string | undefined;
  spanId: string | undefined;
  responseId: string | undefined;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number | undefined;
};

export type CopilotSourceAdapterOptions = {
  otelDir?: string;
  requireOtelDir?: boolean;
  env?: NodeJS.ProcessEnv;
};

function shouldParseCopilotJsonlLine(lineText: string): boolean {
  return lineText.includes('"attributes"');
}

function toText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return asTrimmedText(value);
  }

  const valueRecord = asRecord(value);
  return asTrimmedText(valueRecord?.stringValue) ?? asTrimmedText(valueRecord?.value);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = toFiniteNumber(value);
  return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed));
}

function getAttribute(attributes: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = attributes[key];

    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function getAttributeText(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return toText(getAttribute(attributes, keys));
}

function getAttributeTokens(attributes: Record<string, unknown>, keys: readonly string[]): number {
  return toNonNegativeInteger(getAttribute(attributes, keys));
}

function normalizeHrTime(candidate: unknown): string | undefined {
  if (!Array.isArray(candidate) || candidate.length < 2) {
    return undefined;
  }

  const seconds = toFiniteNumber(candidate[0]);
  const nanos = toFiniteNumber(candidate[1]);

  if (seconds === undefined || nanos === undefined) {
    return undefined;
  }

  const timestampMs = seconds * 1000 + nanos / 1_000_000;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeUnixNanos(candidate: unknown): string | undefined {
  const nanos = toFiniteNumber(candidate);

  if (nanos === undefined) {
    return undefined;
  }

  const date = new Date(nanos / 1_000_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resolveTimestamp(record: Record<string, unknown>): string | undefined {
  for (const key of ['endTime', 'startTime', 'hrTime', '_hrTime', 'time']) {
    const timestamp = normalizeHrTime(record[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  for (const key of ['timestamp', 'observedTimestamp']) {
    const timestamp = normalizeTimestampCandidate(record[key]);

    if (timestamp) {
      return timestamp;
    }
  }

  return normalizeUnixNanos(record.timeUnixNano);
}

function getBodyText(record: Record<string, unknown>): string | undefined {
  const body = record.body;

  if (typeof body === 'string') {
    return asTrimmedText(body);
  }

  const bodyRecord = asRecord(body);
  return toText(bodyRecord?.stringValue) ?? toText(bodyRecord?.value);
}

function getEventName(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>,
): string {
  const eventRecord = asRecord(record.event);

  return (
    getAttributeText(attributes, ['event.name']) ??
    asTrimmedText(record['event.name']) ??
    asTrimmedText(eventRecord?.name) ??
    ''
  );
}

function classifyRecord(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>,
): number | undefined {
  const operationName = getAttributeText(attributes, ['gen_ai.operation.name']) ?? '';
  const spanName = asTrimmedText(record.name) ?? '';
  const eventName = getEventName(record, attributes);
  const body = getBodyText(record) ?? '';

  if (operationName === 'chat' || spanName.startsWith('chat ')) {
    return 1;
  }

  if (
    eventName === 'gen_ai.client.inference.operation.details' ||
    body.startsWith('GenAI inference:')
  ) {
    return 2;
  }

  if (eventName === 'copilot_chat.agent.turn' || body.startsWith('copilot_chat.agent.turn')) {
    return 3;
  }

  if (operationName === 'invoke_agent' || spanName.startsWith('invoke_agent ')) {
    return 4;
  }

  return undefined;
}

function hasTokenUsage(candidate: CopilotCandidate): boolean {
  return (
    candidate.inputTokens +
      candidate.outputTokens +
      candidate.reasoningTokens +
      candidate.cacheReadTokens +
      candidate.cacheWriteTokens +
      (candidate.totalTokens ?? 0) >
    0
  );
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function extractCandidate(
  record: Record<string, unknown>,
  filePath: string,
  lineIndex: number,
): CopilotCandidate | undefined {
  const attributes = asRecord(record.attributes);

  if (!attributes) {
    return undefined;
  }

  const priority = classifyRecord(record, attributes);

  if (priority === undefined) {
    return undefined;
  }

  const cacheReadTokens = getAttributeTokens(attributes, [
    'gen_ai.usage.cache_read.input_tokens',
    'gen_ai.usage.cache_read_input_tokens',
  ]);
  const inputTokensRaw = getAttributeTokens(attributes, ['gen_ai.usage.input_tokens']);
  const inputTokens = inputTokensRaw - Math.min(inputTokensRaw, cacheReadTokens);
  const totalTokens = getAttributeTokens(attributes, [
    'gen_ai.usage.total_tokens',
    'gen_ai.usage.total.token_count',
  ]);
  const traceId = asTrimmedText(record.traceId) ?? asTrimmedText(record.trace_id);
  const responseId = getAttributeText(attributes, ['gen_ai.response.id']);
  const sessionId =
    getAttributeText(attributes, [
      'gen_ai.conversation.id',
      'copilot_chat.session_id',
      'copilot_chat.chat_session_id',
      'session.id',
    ]) ??
    getAttributeText(attributes, ['github.copilot.interaction_id']) ??
    responseId ??
    traceId ??
    getFallbackSessionId(filePath);

  return {
    priority,
    lineIndex,
    timestamp: resolveTimestamp(record),
    sessionId,
    traceId,
    spanId: asTrimmedText(record.spanId) ?? asTrimmedText(record.span_id),
    responseId,
    model:
      getAttributeText(attributes, ['gen_ai.response.model']) ??
      getAttributeText(attributes, ['gen_ai.request.model']),
    inputTokens,
    outputTokens: getAttributeTokens(attributes, ['gen_ai.usage.output_tokens']),
    reasoningTokens: getAttributeTokens(attributes, [
      'gen_ai.usage.reasoning.output_tokens',
      'gen_ai.usage.reasoning_tokens',
    ]),
    cacheReadTokens,
    cacheWriteTokens: getAttributeTokens(attributes, [
      'gen_ai.usage.cache_write.input_tokens',
      'gen_ai.usage.cache_creation.input_tokens',
      'gen_ai.usage.cache_write_input_tokens',
      'gen_ai.usage.cache_creation_input_tokens',
    ]),
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
  };
}

function applyClassPriorityGuard(candidates: readonly CopilotCandidate[]): CopilotCandidate[] {
  const sortedCandidates = [...candidates].sort((left, right) => left.priority - right.priority);
  const keptCandidates: CopilotCandidate[] = [];
  const seenTraceIds = new Set<string>();
  const seenResponseIds = new Set<string>();

  for (const candidate of sortedCandidates) {
    const hasTraceCollision =
      candidate.traceId !== undefined && seenTraceIds.has(candidate.traceId);
    const hasResponseCollision =
      candidate.responseId !== undefined && seenResponseIds.has(candidate.responseId);

    if (hasTraceCollision || hasResponseCollision) {
      continue;
    }

    keptCandidates.push(candidate);

    if (candidate.traceId) {
      seenTraceIds.add(candidate.traceId);
    }

    if (candidate.responseId) {
      seenResponseIds.add(candidate.responseId);
    }
  }

  return keptCandidates.sort((left, right) => left.lineIndex - right.lineIndex);
}

function dedupeCandidates(
  filePath: string,
  candidates: readonly CopilotCandidate[],
): CopilotCandidate[] {
  const seenKeys = new Set<string>();
  const dedupedCandidates: CopilotCandidate[] = [];

  for (const candidate of candidates) {
    const identity = candidate.traceId ?? candidate.sessionId;
    const localId = candidate.spanId ?? String(candidate.lineIndex);
    const dedupKey = `${filePath}\0${identity}\0${localId}`;

    if (seenKeys.has(dedupKey)) {
      continue;
    }

    seenKeys.add(dedupKey);
    dedupedCandidates.push(candidate);
  }

  return dedupedCandidates;
}

function toUsageEvent(candidate: CopilotCandidate): UsageEvent {
  return createUsageEvent({
    source: 'copilot',
    sessionId: candidate.sessionId,
    timestamp: candidate.timestamp ?? '',
    model: candidate.model,
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    reasoningTokens: candidate.reasoningTokens,
    cacheReadTokens: candidate.cacheReadTokens,
    cacheWriteTokens: candidate.cacheWriteTokens,
    totalTokens: candidate.totalTokens,
    costMode: 'estimated',
  });
}

export class CopilotSourceAdapter implements SourceAdapter {
  public readonly id = 'copilot' as const;

  private readonly rootDirs: readonly string[];
  private readonly envFilePath: string | undefined;
  private readonly requireOtelDir: boolean;

  public constructor(options: CopilotSourceAdapterOptions = {}) {
    const env = options.env ?? process.env;
    const envFilePath = asTrimmedText(env.COPILOT_OTEL_FILE_EXPORTER_PATH);
    this.rootDirs = [options.otelDir ?? defaultOtelDir];
    this.envFilePath = envFilePath;
    this.requireOtelDir = options.requireOtelDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    const discoveredFiles: string[] = [];

    for (const rootDir of this.rootDirs) {
      discoveredFiles.push(...(await this.discoverFilesInRoot(rootDir)));
    }

    if (this.envFilePath) {
      const resolvedEnvFile = await this.resolveEnvFilePath(this.envFilePath);

      if (resolvedEnvFile) {
        discoveredFiles.push(resolvedEnvFile);
      }
    }

    return [...new Set(discoveredFiles)].sort(compareByCodePoint);
  }

  private async discoverFilesInRoot(rootDir: string): Promise<string[]> {
    if (isBlankText(rootDir)) {
      throw new Error('Copilot OTEL directory must be a non-empty path');
    }

    const normalizedRootDir = rootDir.trim();

    if (this.requireOtelDir && !(await pathReadable(normalizedRootDir))) {
      throw new Error(`Copilot OTEL directory is missing or unreadable: ${normalizedRootDir}`);
    }

    if (this.requireOtelDir && !(await pathIsDirectory(normalizedRootDir))) {
      throw new Error(`Copilot OTEL directory is not a directory: ${normalizedRootDir}`);
    }

    return discoverJsonlFiles(normalizedRootDir);
  }

  private async resolveEnvFilePath(filePath: string): Promise<string | undefined> {
    if (!(await pathReadable(filePath)) || !(await pathIsFile(filePath))) {
      return undefined;
    }

    return realpath(filePath);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const candidates: CopilotCandidate[] = [];
    const skippedRowReasons = new Map<string, number>();
    let skippedRows = 0;
    let lineIndex = 0;

    for await (const record of readJsonlObjects(filePath, {
      shouldParseLine: shouldParseCopilotJsonlLine,
    })) {
      const candidate = extractCandidate(record, filePath, lineIndex);
      lineIndex++;

      if (!candidate) {
        continue;
      }

      if (!hasTokenUsage(candidate)) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'no_token_usage');
        continue;
      }

      if (!candidate.timestamp) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      candidates.push(candidate);
    }

    const events = dedupeCandidates(filePath, applyClassPriorityGuard(candidates)).map(
      toUsageEvent,
    );

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

export function getDefaultCopilotOtelDir(): string {
  return defaultOtelDir;
}
