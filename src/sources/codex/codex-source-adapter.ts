import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  toNumberLike,
} from '../parsing-utils.js';
import type { SourceAdapter } from '../source-adapter.js';

const defaultSessionsDir = path.join(os.homedir(), '.codex', 'sessions');

export const LEGACY_CODEX_MODEL_FALLBACK = 'legacy-codex-unknown';

type CodexUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type CodexSessionState = {
  sessionId: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
  previousTotalUsage?: CodexUsage;
  previousLastUsageOnlyKey?: string;
};

export type CodexSourceAdapterOptions = {
  sessionsDir?: string;
  requireSessionsDir?: boolean;
};

const SESSION_META_LINE_PATTERN = /"type"\s*:\s*"session_meta"/u;
const TURN_CONTEXT_LINE_PATTERN = /"type"\s*:\s*"turn_context"/u;
const EVENT_MSG_LINE_PATTERN = /"type"\s*:\s*"event_msg"/u;
const TOKEN_COUNT_LINE_PATTERN = /"type"\s*:\s*"token_count"/u;

function shouldParseCodexJsonlLine(lineText: string): boolean {
  if (SESSION_META_LINE_PATTERN.test(lineText) || TURN_CONTEXT_LINE_PATTERN.test(lineText)) {
    return true;
  }

  return EVENT_MSG_LINE_PATTERN.test(lineText) && TOKEN_COUNT_LINE_PATTERN.test(lineText);
}

function toUsage(value: unknown): CodexUsage | undefined {
  const usage = asRecord(value);

  if (!usage) {
    return undefined;
  }

  const rawInputTokens = normalizeNonNegativeInteger(toNumberLike(usage.input_tokens));
  const cacheReadTokens = normalizeNonNegativeInteger(toNumberLike(usage.cached_input_tokens));
  const outputTokens = normalizeNonNegativeInteger(toNumberLike(usage.output_tokens));

  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);

  return {
    // Codex input_tokens includes cached_input_tokens. We store net input separately
    // to avoid double counting input + cache read in reports and estimated pricing.
    inputTokens,
    cacheReadTokens,
    outputTokens,
    reasoningTokens: normalizeNonNegativeInteger(toNumberLike(usage.reasoning_output_tokens)),
    // Match ccusage semantics: billable total excludes reasoning breakdown.
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
  };
}

function subtractUsage(current: CodexUsage, previous: CodexUsage): CodexUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

function addUsage(left: CodexUsage, right: CodexUsage): CodexUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function hasUsageSignal(usage: CodexUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.totalTokens > 0
  );
}

function hasUsageRollback(current: CodexUsage, previous: CodexUsage): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.cacheReadTokens < previous.cacheReadTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens ||
    current.totalTokens < previous.totalTokens
  );
}

function deriveDeltaUsage(
  info: Record<string, unknown>,
  previousTotalUsage: CodexUsage | undefined,
): {
  deltaUsage?: CodexUsage;
  latestTotalUsage?: CodexUsage;
  fromLastUsageOnly?: boolean;
} {
  const totalUsage = toUsage(info.total_token_usage);
  const lastUsage = toUsage(info.last_token_usage);

  if (totalUsage && previousTotalUsage) {
    if (hasUsageRollback(totalUsage, previousTotalUsage)) {
      if (lastUsage && hasUsageSignal(lastUsage)) {
        return { deltaUsage: lastUsage, latestTotalUsage: totalUsage };
      }

      return {
        deltaUsage: hasUsageSignal(totalUsage) ? totalUsage : undefined,
        latestTotalUsage: totalUsage,
      };
    }

    const deltaFromTotals = subtractUsage(totalUsage, previousTotalUsage);

    if (hasUsageSignal(deltaFromTotals)) {
      return { deltaUsage: deltaFromTotals, latestTotalUsage: totalUsage };
    }

    // Duplicate token_count rows can repeat the last per-turn usage while totals stay unchanged.
    // Prefer totals and treat unchanged totals as no new usage signal.
    return { latestTotalUsage: totalUsage };
  }

  if (lastUsage) {
    return { deltaUsage: lastUsage, latestTotalUsage: totalUsage, fromLastUsageOnly: true };
  }

  if (!totalUsage) {
    return {};
  }

  const deltaUsage = previousTotalUsage
    ? subtractUsage(totalUsage, previousTotalUsage)
    : totalUsage;

  return { deltaUsage, latestTotalUsage: totalUsage };
}

function createLastUsageOnlyKey(timestamp: string, usage: CodexUsage): string {
  return [
    timestamp,
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ].join(':');
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveRepoRootFromPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) {
    return undefined;
  }

  return (
    asTrimmedText(payload.cwd) ??
    asTrimmedText(payload.repo_root) ??
    asTrimmedText(payload.repoRoot) ??
    asTrimmedText(payload.project_root) ??
    asTrimmedText(payload.projectRoot)
  );
}

export class CodexSourceAdapter implements SourceAdapter {
  public readonly id = 'codex' as const;
  public readonly capabilities = {
    fixedProviderRoots: ['openai'],
  } as const;

  private readonly sessionsDir: string;
  private readonly requireSessionsDir: boolean;

  public constructor(options: CodexSourceAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir;
    this.requireSessionsDir = options.requireSessionsDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    if (isBlankText(this.sessionsDir)) {
      throw new Error('Codex sessions directory must be a non-empty path');
    }

    const normalizedSessionsDir = this.sessionsDir.trim();

    if (this.requireSessionsDir) {
      const sessionsDirStats = await pathStat(normalizedSessionsDir);

      if (!sessionsDirStats) {
        throw new Error(
          `Codex sessions directory is missing or unreadable: ${normalizedSessionsDir}`,
        );
      }

      if (!sessionsDirStats.isDirectory()) {
        throw new Error(`Codex sessions directory is not a directory: ${normalizedSessionsDir}`);
      }
    }

    return discoverJsonlFiles(normalizedSessionsDir);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];

    const state: CodexSessionState = {
      sessionId: getFallbackSessionId(filePath),
      provider: 'openai',
    };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParseCodexJsonlLine,
    })) {
      if (line.type === 'session_meta') {
        const payload = asRecord(line.payload);
        state.sessionId = asTrimmedText(payload?.id) ?? state.sessionId;
        state.provider = asTrimmedText(payload?.model_provider) ?? state.provider;
        state.repoRoot = resolveRepoRootFromPayload(payload) ?? state.repoRoot;
        continue;
      }

      if (line.type === 'turn_context') {
        const payload = asRecord(line.payload);
        state.model = asTrimmedText(payload?.model) ?? state.model;
        state.repoRoot = resolveRepoRootFromPayload(payload) ?? state.repoRoot;
        continue;
      }

      if (line.type !== 'event_msg') {
        continue;
      }

      const payload = asRecord(line.payload);

      if (payload?.type !== 'token_count') {
        continue;
      }

      const info = asRecord(payload.info);

      if (!info) {
        continue;
      }

      const { deltaUsage, latestTotalUsage, fromLastUsageOnly } = deriveDeltaUsage(
        info,
        state.previousTotalUsage,
      );

      if (!deltaUsage || !hasUsageSignal(deltaUsage)) {
        if (!fromLastUsageOnly) {
          state.previousLastUsageOnlyKey = undefined;
        }

        state.previousTotalUsage = latestTotalUsage ?? state.previousTotalUsage;
        continue;
      }

      const timestamp = normalizeTimestampCandidate(line.timestamp);

      if (!timestamp) {
        if (!fromLastUsageOnly) {
          state.previousLastUsageOnlyKey = undefined;
        }

        state.previousTotalUsage = latestTotalUsage ?? state.previousTotalUsage;
        continue;
      }

      if (fromLastUsageOnly) {
        const currentLastUsageOnlyKey = createLastUsageOnlyKey(timestamp, deltaUsage);

        if (state.previousLastUsageOnlyKey === currentLastUsageOnlyKey) {
          continue;
        }

        state.previousLastUsageOnlyKey = currentLastUsageOnlyKey;
      } else {
        state.previousLastUsageOnlyKey = undefined;
      }

      const model = state.model ?? LEGACY_CODEX_MODEL_FALLBACK;

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: state.sessionId,
            timestamp,
            repoRoot: state.repoRoot,
            provider: state.provider,
            model,
            inputTokens: deltaUsage.inputTokens,
            outputTokens: deltaUsage.outputTokens,
            reasoningTokens: deltaUsage.reasoningTokens,
            cacheReadTokens: deltaUsage.cacheReadTokens,
            cacheWriteTokens: 0,
            totalTokens: deltaUsage.totalTokens,
            costMode: 'estimated',
          }),
        );
      } catch {
        // no-op: malformed lines are ignored by design
      }

      if (latestTotalUsage) {
        state.previousTotalUsage = latestTotalUsage;
      } else if (state.previousTotalUsage) {
        state.previousTotalUsage = addUsage(state.previousTotalUsage, deltaUsage);
      } else {
        state.previousTotalUsage = deltaUsage;
      }
    }

    return events;
  }
}

export function getDefaultCodexSessionsDir(): string {
  return defaultSessionsDir;
}
