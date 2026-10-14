import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { collectFile } from '../../stream/collect.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  normalizeTimestampCandidate,
  resolveTotalTokens,
  toTokenCount,
} from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
  SourceReadDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';

export function resolveDefaultKimiRootDirs(context: SourceContext): string[] {
  return [
    path.join(context.homeDir, '.kimi', 'sessions'),
    path.join(context.homeDir, '.kimi-code', 'sessions'),
  ];
}

const KIMI_STATUS_UPDATE_LINE_TEXT = '"StatusUpdate"';
const KIMI_USAGE_RECORD_LINE_TEXT = '"usage.record"';
const KIMI_CODE_MODEL_PREFIX = 'kimi-code/';
const KIMI_PROVIDER = 'moonshot';
// kimi-cli StatusUpdate lines carry no model. When <kimiRoot>/config.json has no model either,
// fall back by event timestamp: kimi-cli's managed "kimi-for-coding" endpoint switched from
// kimi-k2.5 to kimi-k2.6 at 2026-04-20T15:28:10.072Z.
const KIMI_K2_6_CUTOFF_MS = 1_776_698_890_072;
const KIMI_K2_5_MODEL = 'kimi-k2.5';
const KIMI_K2_6_MODEL = 'kimi-k2.6';

export type KimiSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
};

type KimiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens?: number;
};

type KimiStatusUpdateCandidate = {
  messageId: string;
  timestamp: string;
  usage: KimiTokenUsage;
  comparableTotalTokens: number;
};

type KimiParseContext = {
  statusUpdates: Map<string, KimiStatusUpdateCandidate>;
  diagnostics: SourceReadDiagnostics;
};

function shouldParseKimiJsonlLine(lineText: string): boolean {
  return (
    lineText.includes(KIMI_STATUS_UPDATE_LINE_TEXT) ||
    lineText.includes(KIMI_USAGE_RECORD_LINE_TEXT)
  );
}

function createTokenUsage(fields: {
  input: unknown;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  total?: unknown;
}): { usage: KimiTokenUsage; comparableTotalTokens: number } | null {
  const inputTokens = toTokenCount(fields.input);
  const outputTokens = toTokenCount(fields.output);
  const reasoningTokens = 0;
  const cacheReadTokens = toTokenCount(fields.cacheRead);
  const cacheWriteTokens = toTokenCount(fields.cacheWrite);
  const declaredTotalTokens = toTokenCount(fields.total);
  const componentTotalTokens =
    inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  const comparableTotalTokens = resolveTotalTokens(declaredTotalTokens, componentTotalTokens);

  if (comparableTotalTokens === 0) {
    return null;
  }

  const usage = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };

  if (declaredTotalTokens > 0) {
    return {
      usage: {
        ...usage,
        totalTokens: declaredTotalTokens,
      },
      comparableTotalTokens,
    };
  }

  return { usage, comparableTotalTokens };
}

function incrementContextSkippedReason(context: KimiParseContext, reason: string): void {
  recordSkippedRow(context.diagnostics, reason);
}

function getCliSessionId(filePath: string): string {
  return path.basename(path.dirname(filePath));
}

// kimi-cli wire files live at <kimiRoot>/sessions/GROUP/UUID/wire.jsonl; config.json sits in <kimiRoot>.
function getCliConfigPath(filePath: string): string {
  const sessionsDir = path.dirname(path.dirname(path.dirname(filePath)));
  return path.join(path.dirname(sessionsDir), 'config.json');
}

// Kimi Code wire files live under an agents dir: <root>/sessions/WORKSPACE/SESSION/agents/AGENT/wire.jsonl.
function isCodeWireFile(filePath: string): boolean {
  return path.basename(path.dirname(path.dirname(filePath))) === 'agents';
}

async function readCliConfigModel(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(getCliConfigPath(filePath), 'utf8');
    return asTrimmedText(asRecord(JSON.parse(content))?.model);
  } catch {
    return undefined;
  }
}

function getCliFallbackModel(timestamp: string): string {
  return Date.parse(timestamp) < KIMI_K2_6_CUTOFF_MS ? KIMI_K2_5_MODEL : KIMI_K2_6_MODEL;
}

function getCodeSessionId(filePath: string): string {
  const agentDir = path.dirname(filePath);
  const agentsDir = path.dirname(agentDir);
  const sessionDir = path.dirname(agentsDir);

  return path.basename(sessionDir);
}

function normalizeKimiCodeModel(model: unknown): string | undefined {
  const normalizedModel = asTrimmedText(model);

  if (!normalizedModel) {
    return undefined;
  }

  if (!normalizedModel.startsWith(KIMI_CODE_MODEL_PREFIX)) {
    return normalizedModel;
  }

  return asTrimmedText(normalizedModel.slice(KIMI_CODE_MODEL_PREFIX.length));
}

function isNewerStatusUpdate(
  next: KimiStatusUpdateCandidate,
  current: KimiStatusUpdateCandidate | undefined,
): boolean {
  if (!current) {
    return true;
  }

  if (next.comparableTotalTokens !== current.comparableTotalTokens) {
    return next.comparableTotalTokens > current.comparableTotalTokens;
  }

  return next.timestamp > current.timestamp;
}

function toUsageEvent(context: KimiParseContext, input: UsageEventInput): UsageEvent | undefined {
  try {
    return createUsageEvent(input);
  } catch {
    incrementContextSkippedReason(context, 'event_creation_failed');
    return undefined;
  }
}

function parseStatusUpdateLine(context: KimiParseContext, line: Record<string, unknown>): void {
  const message = asRecord(line.message);

  if (message?.type !== 'StatusUpdate') {
    return;
  }

  const payload = asRecord(message.payload);
  const tokenUsage = asRecord(payload?.token_usage);

  if (!tokenUsage) {
    return;
  }

  const usageResult = createTokenUsage({
    input: tokenUsage.input_other,
    output: tokenUsage.output,
    cacheRead: tokenUsage.input_cache_read,
    cacheWrite: tokenUsage.input_cache_creation,
    total: tokenUsage.total,
  });

  if (!usageResult) {
    incrementContextSkippedReason(context, 'no_token_usage');
    return;
  }

  const timestamp = normalizeTimestampCandidate(line.timestamp);

  if (!timestamp) {
    incrementContextSkippedReason(context, 'invalid_timestamp');
    return;
  }

  const messageId = asTrimmedText(payload?.message_id);

  if (!messageId) {
    incrementContextSkippedReason(context, 'event_creation_failed');
    return;
  }

  const candidate: KimiStatusUpdateCandidate = {
    messageId,
    timestamp,
    usage: usageResult.usage,
    comparableTotalTokens: usageResult.comparableTotalTokens,
  };

  if (isNewerStatusUpdate(candidate, context.statusUpdates.get(messageId))) {
    context.statusUpdates.set(messageId, candidate);
  }
}

function parseUsageRecordLine(
  context: KimiParseContext,
  filePath: string,
  line: Record<string, unknown>,
): UsageEvent | undefined {
  if (line.type !== 'usage.record' || line.usageScope !== 'turn') {
    return undefined;
  }

  const usage = asRecord(line.usage);
  const usageResult = createTokenUsage({
    input: usage?.inputOther,
    output: usage?.output,
    cacheRead: usage?.inputCacheRead,
    cacheWrite: usage?.inputCacheCreation,
  });

  if (!usageResult) {
    incrementContextSkippedReason(context, 'no_token_usage');
    return undefined;
  }

  const timestamp = normalizeTimestampCandidate(line.time);

  if (!timestamp) {
    incrementContextSkippedReason(context, 'invalid_timestamp');
    return undefined;
  }

  return toUsageEvent(context, {
    source: 'kimi',
    sessionId: getCodeSessionId(filePath),
    timestamp,
    provider: KIMI_PROVIDER,
    model: normalizeKimiCodeModel(line.model),
    ...usageResult.usage,
  });
}

async function discoverWireFiles(rootDir: string): Promise<string[]> {
  const jsonlFiles = await discoverFiles(rootDir, { extension: '.jsonl' });
  return jsonlFiles.filter((filePath) => path.basename(filePath) === 'wire.jsonl');
}

export class KimiSourceAdapter implements SourceAdapter {
  public readonly id = 'kimi' as const;
  public readonly capabilities = {
    fixedProviderRoots: [KIMI_PROVIDER],
    eventsPrecedeFileMtime: true,
  };

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: KimiSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ??
        resolveDefaultKimiRootDirs(options.context ?? createSourceContext()),
    );
    this.requireDir = options.requireDir ?? false;
  }

  public getSearchPaths(): string[] {
    return this.rootDirs.map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireDir,
      directoryLabel: 'Kimi sessions directory',
      discoverInRoot: (rootDir) => discoverWireFiles(rootDir),
      sortAcrossRoots: true,
    });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return isCodeWireFile(filePath) ? [] : [getCliConfigPath(filePath)];
  }

  public async *read(
    filePath: string,
    options: SourceReadOptions = {},
  ): AsyncGenerator<UsageEvent> {
    const context: KimiParseContext = {
      statusUpdates: new Map(),
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
    };

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParseKimiJsonlLine,
      onMalformedLine: () => {
        incrementContextSkippedReason(context, 'json_parse_error');
      },
    })) {
      parseStatusUpdateLine(context, line);
      const usageRecordEvent = parseUsageRecordLine(context, filePath, line);

      if (usageRecordEvent) {
        yield usageRecordEvent;
      }
    }

    // StatusUpdate keeps the largest update per message id, so those events wait for EOF.
    const configModel =
      context.statusUpdates.size > 0 ? await readCliConfigModel(filePath) : undefined;

    for (const candidate of context.statusUpdates.values()) {
      const event = toUsageEvent(context, {
        source: this.id,
        sessionId: getCliSessionId(filePath),
        timestamp: candidate.timestamp,
        provider: KIMI_PROVIDER,
        model: configModel ?? getCliFallbackModel(candidate.timestamp),
        ...candidate.usage,
      });

      if (event) {
        yield event;
      }
    }
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    return (await collectFile(this, filePath)).events;
  }

  public parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    return collectFile(this, filePath);
  }
}
