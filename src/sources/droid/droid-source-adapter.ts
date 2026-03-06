import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { asTrimmedText, isBlankText, toNumberLike } from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';

const defaultSessionsDir = path.join(os.homedir(), '.factory', 'sessions');

export type DroidSourceAdapterOptions = {
  sessionsDir?: string;
  requireSessionsDir?: boolean;
};

const DROID_SESSION_START_LINE_PATTERN = /"type"\s*:\s*"session_start"/u;
const DROID_MESSAGE_LINE_PATTERN = /"type"\s*:\s*"message"/u;

function shouldParseDroidJsonlLine(lineText: string): boolean {
  return (
    DROID_SESSION_START_LINE_PATTERN.test(lineText) || DROID_MESSAGE_LINE_PATTERN.test(lineText)
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

function getSettingsSessionId(filePath: string): string {
  return path.basename(filePath, '.settings.json');
}

function getSiblingJsonlPath(settingsPath: string): string {
  return path.join(path.dirname(settingsPath), `${getSettingsSessionId(settingsPath)}.jsonl`);
}

function isSessionStartRecord(line: Record<string, unknown>): boolean {
  return asTrimmedText(line.type) === 'session_start';
}

function isMessageRecord(line: Record<string, unknown>): boolean {
  return asTrimmedText(line.type) === 'message';
}

function resolveRepoRootFromSessionStart(line: Record<string, unknown>): string | undefined {
  const payload = asRecord(line.session_start);
  return asTrimmedText(payload?.cwd);
}

export class DroidSourceAdapter implements SourceAdapter {
  public readonly id = 'droid' as const;

  private readonly sessionsDir: string;
  private readonly requireSessionsDir: boolean;

  public constructor(options: DroidSourceAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir;
    this.requireSessionsDir = options.requireSessionsDir ?? false;
  }

  private getNormalizedSessionsDir(): string {
    if (isBlankText(this.sessionsDir)) {
      throw new Error('Droid sessions directory must be a non-empty path');
    }

    return this.sessionsDir.trim();
  }

  public async discoverFiles(): Promise<string[]> {
    const normalizedDir = this.getNormalizedSessionsDir();

    if (this.requireSessionsDir && !(await pathReadable(normalizedDir))) {
      throw new Error(`Droid sessions directory is missing or unreadable: ${normalizedDir}`);
    }

    if (this.requireSessionsDir && !(await pathIsDirectory(normalizedDir))) {
      throw new Error(`Droid sessions directory is not a directory: ${normalizedDir}`);
    }

    return discoverFiles(normalizedDir, { extension: '.settings.json' });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return [getSiblingJsonlPath(filePath)];
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();

    let settingsJson: unknown;

    try {
      const content = await readFile(filePath, 'utf8');
      settingsJson = JSON.parse(content) as unknown;
    } catch {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const settings = asRecord(settingsJson);

    if (!settings) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_settings_data');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const tokenUsage = asRecord(settings.tokenUsage);

    if (!tokenUsage) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'no_token_usage');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const inputTokens = normalizeNonNegativeInteger(toNumberLike(tokenUsage.inputTokens));
    const outputTokens = normalizeNonNegativeInteger(toNumberLike(tokenUsage.outputTokens));
    const reasoningTokens = normalizeNonNegativeInteger(toNumberLike(tokenUsage.thinkingTokens));
    const cacheReadTokens = normalizeNonNegativeInteger(toNumberLike(tokenUsage.cacheReadTokens));
    const cacheWriteTokens = normalizeNonNegativeInteger(
      toNumberLike(tokenUsage.cacheCreationTokens),
    );
    const billableTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    if (billableTokens === 0) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'no_token_usage');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const provider = asTrimmedText(settings.providerLock);
    const model = asTrimmedText(settings.model);
    const totalTokens = billableTokens;

    const primaryTimestamp = normalizeTimestampCandidate(settings.providerLockTimestamp);
    const hasValidPrimaryTimestamp = Boolean(primaryTimestamp);

    const jsonlPath = getSiblingJsonlPath(filePath);

    let repoRoot: string | undefined;
    let fallbackMessageTimestamp: string | undefined;

    try {
      for await (const line of readJsonlObjects(jsonlPath, {
        shouldParseLine: shouldParseDroidJsonlLine,
      })) {
        if (!repoRoot && isSessionStartRecord(line)) {
          repoRoot = resolveRepoRootFromSessionStart(line) ?? repoRoot;

          if (hasValidPrimaryTimestamp) {
            break;
          }

          continue;
        }

        if (!hasValidPrimaryTimestamp && isMessageRecord(line)) {
          fallbackMessageTimestamp = normalizeTimestampCandidate(line.timestamp);

          if (fallbackMessageTimestamp) {
            break;
          }
        }
      }
    } catch {
      // fail-open: JSONL enrichment is optional
    }

    const timestamp = primaryTimestamp ?? fallbackMessageTimestamp;

    if (!timestamp) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    try {
      events.push(
        createUsageEvent({
          source: this.id,
          sessionId: getSettingsSessionId(filePath),
          timestamp,
          repoRoot,
          provider,
          model,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens,
          costMode: 'estimated',
        }),
      );
    } catch {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
    }

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

export function getDefaultDroidSessionsDir(): string {
  return defaultSessionsDir;
}
