import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import type { NumberLike } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { asTrimmedText, isBlankText, toNumberLike } from '../parsing-utils.js';
import type { SourceAdapter } from '../source-adapter.js';

const defaultSessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');

type PiSessionState = {
  sessionId?: string;
  sessionTimestamp?: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

type PiUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
  costUsd?: NumberLike;
};

export type PiSourceAdapterOptions = {
  sessionsDir?: string;
  requireSessionsDir?: boolean;
};

const PI_MESSAGE_LINE_PATTERN = /"type"\s*:\s*"message"/u;
const PI_SESSION_LINE_PATTERN = /"type"\s*:\s*"session"/u;
const PI_MODEL_CHANGE_LINE_PATTERN = /"type"\s*:\s*"model_change"/u;

function shouldParsePiJsonlLine(lineText: string): boolean {
  return (
    PI_MESSAGE_LINE_PATTERN.test(lineText) ||
    PI_SESSION_LINE_PATTERN.test(lineText) ||
    PI_MODEL_CHANGE_LINE_PATTERN.test(lineText)
  );
}

const UNIX_SECONDS_ABS_CUTOFF = 10_000_000_000;

function normalizeTimestampCandidate(candidate: unknown): string | undefined {
  let date: Date | undefined;

  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    const timestampMs =
      Math.abs(candidate) <= UNIX_SECONDS_ABS_CUTOFF ? candidate * 1000 : candidate;
    date = new Date(timestampMs);
  } else {
    const normalizedText = asTrimmedText(candidate);

    if (!normalizedText) {
      return undefined;
    }

    date = new Date(normalizedText);
  }

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function resolveTimestamp(
  line: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  state: PiSessionState,
): string | undefined {
  const candidates = [line.timestamp, message?.timestamp, state.sessionTimestamp];

  for (const candidate of candidates) {
    const normalizedTimestamp = normalizeTimestampCandidate(candidate);

    if (normalizedTimestamp) {
      return normalizedTimestamp;
    }
  }

  return undefined;
}

function extractUsageFromRecord(usage: Record<string, unknown>): PiUsageExtract | undefined {
  const cost = asRecord(usage.cost);

  const extracted: PiUsageExtract = {
    inputTokens: toNumberLike(usage.input),
    outputTokens: toNumberLike(usage.output),
    reasoningTokens: toNumberLike(
      usage.reasoning ?? usage.reasoningTokens ?? usage.reasoningOutput ?? usage.outputReasoning,
    ),
    cacheReadTokens: toNumberLike(usage.cacheRead),
    cacheWriteTokens: toNumberLike(usage.cacheWrite),
    totalTokens: toNumberLike(usage.totalTokens),
    costUsd: toNumberLike(cost?.total),
  };

  const toFiniteNumber = (value: NumberLike | undefined): number | undefined => {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value === 'string' && value.trim().length === 0) {
      return undefined;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return parsed;
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

function extractUsage(line: Record<string, unknown>, message: Record<string, unknown> | undefined) {
  const lineUsage = asRecord(line.usage);
  const messageUsage = asRecord(message?.usage);

  if (lineUsage) {
    const extractedLineUsage = extractUsageFromRecord(lineUsage);

    if (extractedLineUsage) {
      return extractedLineUsage;
    }
  }

  if (!messageUsage) {
    return undefined;
  }

  return extractUsageFromRecord(messageUsage);
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
    asTrimmedText(pathRecord?.root) ??
    asTrimmedText(pathRecord?.cwd) ??
    asTrimmedText(record.cwd) ??
    asTrimmedText(record.repo_root) ??
    asTrimmedText(record.repoRoot) ??
    asTrimmedText(record.project_root) ??
    asTrimmedText(record.projectRoot)
  );
}

export class PiSourceAdapter implements SourceAdapter {
  public readonly id = 'pi' as const;

  private readonly sessionsDir: string;
  private readonly requireSessionsDir: boolean;

  public constructor(options: PiSourceAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir;
    this.requireSessionsDir = options.requireSessionsDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    if (isBlankText(this.sessionsDir)) {
      throw new Error('PI sessions directory must be a non-empty path');
    }

    const normalizedSessionsDir = this.sessionsDir.trim();

    if (this.requireSessionsDir && !(await pathReadable(normalizedSessionsDir))) {
      throw new Error(`PI sessions directory is missing or unreadable: ${normalizedSessionsDir}`);
    }

    if (this.requireSessionsDir && !(await pathIsDirectory(normalizedSessionsDir))) {
      throw new Error(`PI sessions directory is not a directory: ${normalizedSessionsDir}`);
    }

    return discoverJsonlFiles(normalizedSessionsDir);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];
    const state: PiSessionState = { sessionId: getFallbackSessionId(filePath) };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParsePiJsonlLine,
    })) {
      if (line.type === 'session') {
        state.sessionId = asTrimmedText(line.id) ?? state.sessionId;
        state.sessionTimestamp = asTrimmedText(line.timestamp) ?? state.sessionTimestamp;
        state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
        continue;
      }

      if (line.type === 'model_change') {
        state.provider = asTrimmedText(line.provider) ?? state.provider;
        state.model = asTrimmedText(line.modelId) ?? asTrimmedText(line.model) ?? state.model;
        state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
        continue;
      }

      if (line.type !== 'message') {
        continue;
      }

      const message = asRecord(line.message);
      const usage = extractUsage(line, message);

      if (!usage) {
        continue;
      }

      const provider =
        asTrimmedText(line.provider) ?? asTrimmedText(message?.provider) ?? state.provider;

      const timestamp = resolveTimestamp(line, message, state);

      if (!timestamp || !state.sessionId) {
        continue;
      }

      const model =
        asTrimmedText(line.model) ??
        asTrimmedText(line.modelId) ??
        asTrimmedText(message?.model) ??
        state.model;
      const repoRoot =
        resolveRepoRootFromRecord(line) ?? resolveRepoRootFromRecord(message) ?? state.repoRoot;

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp,
            repoRoot,
            provider,
            model,
            ...usage,
          }),
        );
      } catch {
        continue;
      }
    }

    return events;
  }
}

export function getDefaultPiSessionsDir(): string {
  return defaultSessionsDir;
}
