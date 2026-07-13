import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  resolveTotalTokens,
  toTokenCount,
} from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { readBoundedJsonFile } from '../read-json-file.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

export type AmpSourceAdapterOptions = SourceAdapterPathOptions & {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type AmpTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

type AmpParseContext = {
  sessionId: string;
  threadCreatedTimestamp: string | undefined;
  messages: Record<string, unknown>[];
  events: UsageEvent[];
  skippedRows: number;
  skippedRowReasons: Map<string, number>;
};

function normalizeEnvPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function resolveDefaultAmpThreadsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const dataHome = normalizeEnvPath(env.XDG_DATA_HOME) ?? path.join(homeDir, '.local', 'share');

  return path.join(dataHome, 'amp', 'threads');
}

function toIdentityText(value: unknown): string | undefined {
  const text = asTrimmedText(value);

  if (text) {
    return text;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return undefined;
}

function extractUsageFromTokenRecord(tokens: Record<string, unknown> | undefined): AmpTokenUsage {
  const inputTokens = toTokenCount(tokens?.input);
  const outputTokens = toTokenCount(tokens?.output);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: toTokenCount(tokens?.total),
  };
}

function extractUsageFromMessageUsage(usage: Record<string, unknown>): AmpTokenUsage {
  const inputTokens = toTokenCount(usage.inputTokens);
  const outputTokens = toTokenCount(usage.outputTokens);
  const cacheReadTokens = toTokenCount(usage.cacheReadInputTokens);
  const cacheWriteTokens = toTokenCount(usage.cacheCreationInputTokens);
  const declaredTotal = toTokenCount(usage.totalTokens);
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = resolveTotalTokens(declaredTotal, componentTotal);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

function hasUsageSignal(usage: AmpTokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.totalTokens > 0
  );
}

function incrementContextSkippedReason(context: AmpParseContext, reason: string): void {
  context.skippedRows++;
  incrementSkippedReason(context.skippedRowReasons, reason);
}

function getThreadMessages(thread: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(thread.messages)) {
    return [];
  }

  return thread.messages.flatMap((message) => {
    const record = asRecord(message);
    return record ? [record] : [];
  });
}

function getLedgerEvents(thread: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const usageLedger = asRecord(thread.usageLedger);

  if (!usageLedger || !Array.isArray(usageLedger.events) || usageLedger.events.length === 0) {
    return undefined;
  }

  return usageLedger.events.flatMap((event) => {
    const record = asRecord(event);
    return record ? [record] : [];
  });
}

function getMessageCacheUsageById(
  messages: readonly Record<string, unknown>[],
): Map<string, Pick<AmpTokenUsage, 'cacheReadTokens' | 'cacheWriteTokens'>> {
  const cacheUsageByMessageId = new Map<
    string,
    Pick<AmpTokenUsage, 'cacheReadTokens' | 'cacheWriteTokens'>
  >();

  for (const message of messages) {
    const messageId = toIdentityText(message.id);

    if (!messageId || cacheUsageByMessageId.has(messageId)) {
      continue;
    }

    const usage = asRecord(message.usage);

    if (!usage) {
      continue;
    }

    cacheUsageByMessageId.set(messageId, {
      cacheReadTokens: toTokenCount(usage.cacheReadInputTokens),
      cacheWriteTokens: toTokenCount(usage.cacheCreationInputTokens),
    });
  }

  return cacheUsageByMessageId;
}

function resolveTimestamp(
  context: AmpParseContext,
  timestampCandidate: unknown,
): string | undefined {
  return normalizeTimestampCandidate(timestampCandidate) ?? context.threadCreatedTimestamp;
}

function pushAmpEvent(
  context: AmpParseContext,
  input: {
    timestamp: string;
    model: string | undefined;
    usage: AmpTokenUsage;
  },
): void {
  try {
    context.events.push(
      createUsageEvent({
        source: 'amp',
        sessionId: context.sessionId,
        timestamp: input.timestamp,
        model: input.model,
        ...input.usage,
        costMode: 'estimated',
      }),
    );
  } catch {
    incrementContextSkippedReason(context, 'event_creation_failed');
  }
}

function parseLedgerEvents(
  context: AmpParseContext,
  ledgerEvents: readonly Record<string, unknown>[],
): void {
  const seenEventIds = new Set<string>();
  const messageCacheUsageById = getMessageCacheUsageById(context.messages);

  for (const event of ledgerEvents) {
    const eventId = toIdentityText(event.id);

    if (eventId) {
      if (seenEventIds.has(eventId)) {
        continue;
      }

      seenEventIds.add(eventId);
    }

    const usage = extractUsageFromTokenRecord(asRecord(event.tokens));
    const toMessageId = toIdentityText(event.toMessageId);
    const cacheUsage = toMessageId ? messageCacheUsageById.get(toMessageId) : undefined;
    const componentTotal =
      usage.inputTokens +
      usage.outputTokens +
      (cacheUsage?.cacheReadTokens ?? 0) +
      (cacheUsage?.cacheWriteTokens ?? 0);
    const usageWithCache = {
      ...usage,
      cacheReadTokens: cacheUsage?.cacheReadTokens ?? 0,
      cacheWriteTokens: cacheUsage?.cacheWriteTokens ?? 0,
      totalTokens: usage.totalTokens > 0 ? usage.totalTokens : componentTotal,
    };

    if (!hasUsageSignal(usageWithCache)) {
      incrementContextSkippedReason(context, 'no_token_usage');
      continue;
    }

    const timestamp = resolveTimestamp(context, event.timestamp);

    if (!timestamp) {
      incrementContextSkippedReason(context, 'invalid_timestamp');
      continue;
    }

    pushAmpEvent(context, {
      timestamp,
      model: asTrimmedText(event.model),
      usage: usageWithCache,
    });
  }
}

function parseMessageUsage(context: AmpParseContext): void {
  const seenMessageIds = new Set<string>();

  for (const message of context.messages) {
    if (message.role !== 'assistant') {
      continue;
    }

    const usageRecord = asRecord(message.usage);

    if (!usageRecord) {
      continue;
    }

    const messageId = toIdentityText(message.id);

    if (messageId) {
      if (seenMessageIds.has(messageId)) {
        continue;
      }

      seenMessageIds.add(messageId);
    }

    const usage = extractUsageFromMessageUsage(usageRecord);

    if (!hasUsageSignal(usage)) {
      incrementContextSkippedReason(context, 'no_token_usage');
      continue;
    }

    const timestamp = resolveTimestamp(context, message.timestamp);

    if (!timestamp) {
      incrementContextSkippedReason(context, 'invalid_timestamp');
      continue;
    }

    pushAmpEvent(context, {
      timestamp,
      model: asTrimmedText(usageRecord.model) ?? asTrimmedText(message.model),
      usage,
    });
  }
}

export class AmpSourceAdapter implements SourceAdapter {
  public readonly id = 'amp' as const;

  private readonly threadsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: AmpSourceAdapterOptions = {}) {
    this.threadsDir =
      options.dir ??
      resolveDefaultAmpThreadsDir(options.env ?? process.env, options.homeDir ?? os.homedir());
    this.requireDir = options.requireDir ?? false;
  }

  private getNormalizedThreadsDir(): string {
    if (isBlankText(this.threadsDir)) {
      throw new Error('Amp threads directory must be a non-empty path');
    }

    return this.threadsDir.trim();
  }

  public async discoverFiles(): Promise<string[]> {
    const normalizedDir = this.getNormalizedThreadsDir();

    if (this.requireDir && !(await pathReadable(normalizedDir))) {
      throw new Error(`Amp threads directory is missing or unreadable: ${normalizedDir}`);
    }

    if (this.requireDir && !(await pathIsDirectory(normalizedDir))) {
      throw new Error(`Amp threads directory is not a directory: ${normalizedDir}`);
    }

    return discoverFiles(normalizedDir, { extension: '.json' });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);

    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();

    const readResult = await readBoundedJsonFile(filePath);

    if (!readResult.ok) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, readResult.reason);

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const threadData = readResult.value;

    const thread = asRecord(threadData);

    if (!thread) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_thread_data');

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const sessionId = asTrimmedText(thread.id);

    if (!sessionId) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_thread_id');

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const context: AmpParseContext = {
      sessionId,
      threadCreatedTimestamp: normalizeTimestampCandidate(thread.created),
      messages: getThreadMessages(thread),
      events,
      skippedRows,
      skippedRowReasons,
    };

    const ledgerEvents = getLedgerEvents(thread);

    if (ledgerEvents) {
      parseLedgerEvents(context, ledgerEvents);
    } else if (Array.isArray(thread.messages)) {
      parseMessageUsage(context);
    } else {
      incrementContextSkippedReason(context, 'invalid_messages_array');
    }

    return toParseDiagnostics(context.events, context.skippedRows, context.skippedRowReasons);
  }
}

export function getDefaultAmpThreadsDir(
  options: Pick<AmpSourceAdapterOptions, 'env' | 'homeDir'> = {},
): string {
  return resolveDefaultAmpThreadsDir(options.env ?? process.env, options.homeDir ?? os.homedir());
}
