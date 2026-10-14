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
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import { readJsonTranscriptFile } from '../read-json-file.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, readEnvPath, type SourceContext } from '../source-context.js';

export type AmpSourceAdapterOptions = SourceAdapterPathOptions;

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
  diagnostics: SourceReadDiagnostics;
};

function resolveDefaultAmpThreadsDir(context: SourceContext): string {
  const dataHome =
    readEnvPath(context, 'XDG_DATA_HOME') ?? path.join(context.homeDir, '.local', 'share');

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

function createAmpEvent(
  context: AmpParseContext,
  input: {
    timestamp: string;
    model: string | undefined;
    usage: AmpTokenUsage;
  },
): UsageEvent | undefined {
  try {
    return createUsageEvent({
      source: 'amp',
      sessionId: context.sessionId,
      timestamp: input.timestamp,
      model: input.model,
      ...input.usage,
    });
  } catch {
    recordSkippedRow(context.diagnostics, 'event_creation_failed');
    return undefined;
  }
}

function* parseLedgerEvents(
  context: AmpParseContext,
  ledgerEvents: readonly Record<string, unknown>[],
): Generator<UsageEvent, void, undefined> {
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
      recordSkippedRow(context.diagnostics, 'no_token_usage');
      continue;
    }

    const timestamp = resolveTimestamp(context, event.timestamp);

    if (!timestamp) {
      recordSkippedRow(context.diagnostics, 'invalid_timestamp');
      continue;
    }

    const usageEvent = createAmpEvent(context, {
      timestamp,
      model: asTrimmedText(event.model),
      usage: usageWithCache,
    });

    if (usageEvent) {
      yield usageEvent;
    }
  }
}

function* parseMessageUsage(context: AmpParseContext): Generator<UsageEvent, void, undefined> {
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
      recordSkippedRow(context.diagnostics, 'no_token_usage');
      continue;
    }

    const timestamp = resolveTimestamp(context, message.timestamp);

    if (!timestamp) {
      recordSkippedRow(context.diagnostics, 'invalid_timestamp');
      continue;
    }

    const usageEvent = createAmpEvent(context, {
      timestamp,
      model: asTrimmedText(usageRecord.model) ?? asTrimmedText(message.model),
      usage,
    });

    if (usageEvent) {
      yield usageEvent;
    }
  }
}

export class AmpSourceAdapter implements SourceAdapter {
  public readonly id = 'amp' as const;
  public readonly parserVersion = 2;
  public readonly capabilities = { eventsPrecedeFileMtime: true, kinds: ['usage'] } as const;

  private readonly threadsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: AmpSourceAdapterOptions = {}) {
    this.threadsDir =
      options.dir ?? resolveDefaultAmpThreadsDir(options.context ?? createSourceContext());
    this.requireDir = options.requireDir ?? false;
  }

  private getNormalizedThreadsDir(): string {
    if (isBlankText(this.threadsDir)) {
      throw new Error('Amp threads directory must be a non-empty path');
    }

    return this.threadsDir.trim();
  }

  public getSearchPaths(): string[] {
    return [this.threadsDir].map((searchPath) => searchPath.trim());
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

  public async *read(
    filePath: string,
    options: SourceReadOptions = {},
  ): AsyncGenerator<UsageEvent> {
    const threadData = await readJsonTranscriptFile(filePath);

    const thread = asRecord(threadData);

    // A document of the wrong shape fails the file, like unreadable JSON, so its stored
    // events stay.
    if (!thread) {
      throw new Error(`Amp thread is not a JSON object: ${filePath}`);
    }

    const sessionId = asTrimmedText(thread.id);

    if (!sessionId) {
      throw new Error(`Amp thread has no id: ${filePath}`);
    }

    const ledgerEvents = getLedgerEvents(thread);

    if (!ledgerEvents && !Array.isArray(thread.messages)) {
      throw new Error(`Amp thread has neither a usage ledger nor a messages array: ${filePath}`);
    }

    const context: AmpParseContext = {
      sessionId,
      threadCreatedTimestamp: normalizeTimestampCandidate(thread.created),
      messages: getThreadMessages(thread),
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
    };

    if (ledgerEvents) {
      yield* parseLedgerEvents(context, ledgerEvents);
    } else {
      yield* parseMessageUsage(context);
    }
  }
}
