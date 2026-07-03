import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import type { NumberLike } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  toNumberLike,
} from '../parsing-utils.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';

const defaultAgentsDir = path.join(os.homedir(), '.openclaw', 'agents');

type OpenClawSessionState = {
  sessionId: string;
  sessionTimestamp?: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

type OpenClawUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
  costUsd?: NumberLike;
};

export type OpenClawSourceAdapterOptions = {
  agentsDir?: string;
  requireAgentsDir?: boolean;
};

const SESSION_LINE_PATTERN = /"type"\s*:\s*"session"/u;
const MESSAGE_LINE_PATTERN = /"type"\s*:\s*"message"/u;
const MODEL_CHANGE_LINE_PATTERN = /"type"\s*:\s*"model_change"/u;
const USAGE_LINE_PATTERN = /"usage"\s*:/u;
const MODEL_LINE_PATTERN = /"model"\s*:/u;
const PROVIDER_LINE_PATTERN = /"provider"\s*:/u;

function shouldParseOpenClawJsonlLine(lineText: string): boolean {
  return (
    SESSION_LINE_PATTERN.test(lineText) ||
    MESSAGE_LINE_PATTERN.test(lineText) ||
    MODEL_CHANGE_LINE_PATTERN.test(lineText) ||
    USAGE_LINE_PATTERN.test(lineText) ||
    MODEL_LINE_PATTERN.test(lineText) ||
    PROVIDER_LINE_PATTERN.test(lineText)
  );
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveRepoRootFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }

  const pathRecord = asRecord(record.path);

  return (
    asTrimmedText(record.cwd) ??
    asTrimmedText(pathRecord?.root) ??
    asTrimmedText(pathRecord?.cwd) ??
    asTrimmedText(record.repo_root) ??
    asTrimmedText(record.repoRoot) ??
    asTrimmedText(record.project_root) ??
    asTrimmedText(record.projectRoot) ??
    asTrimmedText(record.workspace)
  );
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asTrimmedText(value);

    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function isAssistantMessage(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  return firstText(line.role, message.role)?.toLowerCase() === 'assistant';
}

function isDeliveryMirror(
  provider: string | undefined,
  model: string | undefined,
  message: Record<string, unknown>,
): boolean {
  const messageKind = firstText(message.kind, message.source, message.provenance);
  return (
    provider?.toLowerCase() === 'openclaw' ||
    model?.toLowerCase() === 'delivery-mirror' ||
    messageKind?.toLowerCase() === 'delivery-mirror'
  );
}

function toFiniteNumber(value: NumberLike | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractCostUsd(usage: Record<string, unknown>): NumberLike {
  const cost = asRecord(usage.cost);

  return (
    toNumberLike(usage.costUsd) ??
    toNumberLike(usage.cost_usd) ??
    toNumberLike(usage.turnUsd) ??
    toNumberLike(usage.turn_usd) ??
    toNumberLike(usage.usd) ??
    toNumberLike(usage.cost) ??
    toNumberLike(cost?.total) ??
    toNumberLike(cost?.usd) ??
    toNumberLike(cost?.turnUsd) ??
    toNumberLike(cost?.turn_usd)
  );
}

function extractUsageFromRecord(usage: Record<string, unknown>): OpenClawUsageExtract | undefined {
  const extracted: OpenClawUsageExtract = {
    inputTokens:
      toNumberLike(usage.input) ??
      toNumberLike(usage.inputTokens) ??
      toNumberLike(usage.input_tokens) ??
      toNumberLike(usage.prompt_tokens),
    outputTokens:
      toNumberLike(usage.output) ??
      toNumberLike(usage.outputTokens) ??
      toNumberLike(usage.output_tokens) ??
      toNumberLike(usage.completion_tokens),
    reasoningTokens:
      toNumberLike(usage.reasoning) ??
      toNumberLike(usage.reasoningTokens) ??
      toNumberLike(usage.reasoning_tokens) ??
      toNumberLike(usage.reasoningOutput) ??
      toNumberLike(usage.reasoning_output_tokens),
    cacheReadTokens:
      toNumberLike(usage.cacheRead) ??
      toNumberLike(usage.cache_read) ??
      toNumberLike(usage.cacheReadTokens) ??
      toNumberLike(usage.cache_read_tokens) ??
      toNumberLike(usage.cached) ??
      toNumberLike(usage.cached_input_tokens),
    cacheWriteTokens:
      toNumberLike(usage.cacheWrite) ??
      toNumberLike(usage.cache_write) ??
      toNumberLike(usage.cacheWriteTokens) ??
      toNumberLike(usage.cache_write_tokens),
    totalTokens:
      toNumberLike(usage.total) ??
      toNumberLike(usage.totalTokens) ??
      toNumberLike(usage.total_tokens),
    costUsd: extractCostUsd(usage),
  };

  const usageCandidates = [
    extracted.inputTokens,
    extracted.outputTokens,
    extracted.reasoningTokens,
    extracted.cacheReadTokens,
    extracted.cacheWriteTokens,
    extracted.totalTokens,
  ];
  const hasPositiveUsageSignal = usageCandidates.some((value) => {
    const parsed = toFiniteNumber(value);
    return parsed !== undefined && parsed > 0;
  });
  const explicitCost = toFiniteNumber(extracted.costUsd);
  const hasPositiveCostSignal = explicitCost !== undefined && explicitCost > 0;

  return hasPositiveUsageSignal || hasPositiveCostSignal ? extracted : undefined;
}

function mergeUsageExtracts(
  primary: OpenClawUsageExtract | undefined,
  fallback: OpenClawUsageExtract | undefined,
): OpenClawUsageExtract | undefined {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  return {
    inputTokens: primary.inputTokens ?? fallback.inputTokens,
    outputTokens: primary.outputTokens ?? fallback.outputTokens,
    reasoningTokens: primary.reasoningTokens ?? fallback.reasoningTokens,
    cacheReadTokens: primary.cacheReadTokens ?? fallback.cacheReadTokens,
    cacheWriteTokens: primary.cacheWriteTokens ?? fallback.cacheWriteTokens,
    totalTokens: primary.totalTokens ?? fallback.totalTokens,
    costUsd: primary.costUsd ?? fallback.costUsd,
  };
}

function extractUsage(line: Record<string, unknown>, message: Record<string, unknown>) {
  const lineUsage = asRecord(line.usage);
  const messageUsage = asRecord(message.usage);
  const extractedLineUsage = lineUsage ? extractUsageFromRecord(lineUsage) : undefined;
  const extractedMessageUsage = messageUsage ? extractUsageFromRecord(messageUsage) : undefined;

  return mergeUsageExtracts(extractedLineUsage, extractedMessageUsage);
}

function resolveTimestamp(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
  state: OpenClawSessionState,
  fallbackTimestamp: string | undefined,
): string | undefined {
  const candidates = [line.timestamp, message.timestamp, fallbackTimestamp, state.sessionTimestamp];

  for (const candidate of candidates) {
    const normalizedTimestamp = normalizeTimestampCandidate(candidate);

    if (normalizedTimestamp) {
      return normalizedTimestamp;
    }
  }

  return undefined;
}

function updateRuntimeStateFromRecord(
  state: OpenClawSessionState,
  record: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
): void {
  state.provider =
    firstText(
      record.provider,
      record.modelProvider,
      record.model_provider,
      nested?.provider,
      nested?.modelProvider,
      nested?.model_provider,
    ) ?? state.provider;
  state.model =
    firstText(
      record.model,
      record.modelId,
      record.model_id,
      nested?.model,
      nested?.modelId,
      nested?.model_id,
    ) ?? state.model;
  state.repoRoot =
    resolveRepoRootFromRecord(record) ?? resolveRepoRootFromRecord(nested) ?? state.repoRoot;
}

export class OpenClawSourceAdapter implements SourceAdapter {
  public readonly id = 'openclaw' as const;

  private readonly agentsDir: string;
  private readonly requireAgentsDir: boolean;

  public constructor(options: OpenClawSourceAdapterOptions = {}) {
    this.agentsDir = options.agentsDir ?? defaultAgentsDir;
    this.requireAgentsDir = options.requireAgentsDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    if (isBlankText(this.agentsDir)) {
      throw new Error('OpenClaw agents directory must be a non-empty path');
    }

    const normalizedAgentsDir = this.agentsDir.trim();

    if (this.requireAgentsDir) {
      const agentsDirStats = await pathStat(normalizedAgentsDir);

      if (!agentsDirStats) {
        throw new Error(
          `OpenClaw agents directory is missing or unreadable: ${normalizedAgentsDir}`,
        );
      }

      if (!agentsDirStats.isDirectory()) {
        throw new Error(`OpenClaw agents directory is not a directory: ${normalizedAgentsDir}`);
      }
    }

    return discoverJsonlFiles(normalizedAgentsDir);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    return (await this.parseFileWithDiagnostics(filePath)).events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();
    const fileStats = await pathStat(filePath);
    const fallbackTimestamp = fileStats?.mtime.toISOString();
    const state: OpenClawSessionState = {
      sessionId: getFallbackSessionId(filePath),
    };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParseOpenClawJsonlLine,
    })) {
      const message = asRecord(line.message) ?? line;

      if (line.type === 'session') {
        state.sessionId = firstText(line.id, line.sessionId, line.session_id) ?? state.sessionId;
        state.sessionTimestamp =
          normalizeTimestampCandidate(line.timestamp) ?? state.sessionTimestamp;
        updateRuntimeStateFromRecord(state, line, message);
        continue;
      }

      if (line.type === 'model_change') {
        updateRuntimeStateFromRecord(state, line, message);
        continue;
      }

      if (line.type !== 'message' || !isAssistantMessage(line, message)) {
        updateRuntimeStateFromRecord(state, line, message);
        continue;
      }

      const rowProvider = firstText(
        line.provider,
        message.provider,
        line.modelProvider,
        message.modelProvider,
        line.model_provider,
        message.model_provider,
      );
      const rowModel = firstText(
        line.model,
        message.model,
        line.modelId,
        message.modelId,
        line.model_id,
        message.model_id,
      );

      // Delivery-mirror rows carry their own openclaw/delivery-mirror markers, so
      // detect them from row-local values only (state-inherited values would both
      // miss real usage after a mirror row and drop real usage in openclaw-provider
      // sessions), and skip them before touching runtime state.
      if (isDeliveryMirror(rowProvider, rowModel, message)) {
        continue;
      }

      updateRuntimeStateFromRecord(state, line, message);

      const provider = rowProvider ?? state.provider;
      const model = rowModel ?? state.model;

      const usage = extractUsage(line, message);

      if (!usage) {
        continue;
      }

      const timestamp = resolveTimestamp(line, message, state, fallbackTimestamp);

      if (!timestamp) {
        continue;
      }

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp,
            repoRoot: state.repoRoot,
            provider,
            model,
            ...usage,
          }),
        );
      } catch {
        skippedRows += 1;
        incrementSkippedReason(skippedRowReasons, 'invalid_usage_event');
        continue;
      }
    }

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

export function getDefaultOpenClawAgentsDir(): string {
  return defaultAgentsDir;
}
