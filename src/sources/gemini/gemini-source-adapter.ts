import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import { asTrimmedText, isBlankText } from '../parsing-utils.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';

const defaultGeminiDir = path.join(os.homedir(), '.gemini');

export type GeminiSourceAdapterOptions = {
  geminiDir?: string;
  requireGeminiDir?: boolean;
};

function getProjectsJsonPath(geminiDir: string): string {
  return path.join(geminiDir, 'projects.json');
}

function parseProjectsJson(data: unknown): Map<string, string> {
  const mapping = new Map<string, string>();
  const record = asRecord(data);

  if (!record) {
    return mapping;
  }

  const projects = asRecord(record.projects);

  if (!projects) {
    return mapping;
  }

  for (const [key, value] of Object.entries(projects)) {
    const projectEntry = asRecord(value);
    const absolutePath = asTrimmedText(projectEntry?.absolutePath);

    if (absolutePath) {
      mapping.set(key, absolutePath);
    }
  }

  return mapping;
}

async function loadProjectsJson(geminiDir: string): Promise<Map<string, string>> {
  const projectsPath = getProjectsJsonPath(geminiDir);

  try {
    const content = await readFile(projectsPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;

    return parseProjectsJson(parsed);
  } catch {
    return new Map();
  }
}

async function discoverSessionFiles(geminiDir: string): Promise<string[]> {
  const tmpDir = path.join(geminiDir, 'tmp');
  let projectEntries: Dirent[];

  try {
    projectEntries = await readdir(tmpDir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const allSessionFiles: string[] = [];

  for (const projectEntry of projectEntries.sort((left, right) =>
    compareByCodePoint(left.name, right.name),
  )) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const chatsDir = path.join(tmpDir, projectEntry.name, 'chats');
    const discoveredChatFiles = await discoverFiles(chatsDir, { extension: '.json' });
    allSessionFiles.push(...discoveredChatFiles);
  }

  return allSessionFiles.sort(compareByCodePoint);
}

function resolveRepoRoot(
  filePath: string,
  sessionData: Record<string, unknown>,
  projectMapping: Map<string, string>,
): string | undefined {
  const projectHash = asTrimmedText(sessionData.projectHash);

  if (projectHash) {
    const mappedRoot = projectMapping.get(projectHash);

    if (mappedRoot) {
      return mappedRoot;
    }
  }

  const chatsDir = path.dirname(filePath);
  const projectDir = path.dirname(chatsDir);
  const projectIdentifier = path.basename(projectDir);

  return projectMapping.get(projectIdentifier);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function extractTokenUsage(tokens: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
} | null {
  if (!tokens) {
    return null;
  }

  const input = Math.max(0, toFiniteNumber(tokens.input) ?? 0);
  const tool = Math.max(0, toFiniteNumber(tokens.tool) ?? 0);
  const output = Math.max(0, toFiniteNumber(tokens.output) ?? 0);
  const thoughts = Math.max(0, toFiniteNumber(tokens.thoughts) ?? 0);
  const cached = Math.max(0, toFiniteNumber(tokens.cached) ?? 0);

  const inputTokens = input + tool;
  const outputTokens = output;
  const reasoningTokens = thoughts;
  const cacheReadTokens = cached;

  const declaredTotal = Math.max(0, toFiniteNumber(tokens.total) ?? 0);
  const componentTotal = inputTokens + outputTokens + reasoningTokens + cacheReadTokens;
  const totalTokens = declaredTotal > 0 ? declaredTotal : componentTotal;

  if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && cached === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    totalTokens,
  };
}

// diagnostics helpers live in ../parse-diagnostics.ts

function normalizeTimestamp(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || isBlankText(candidate)) {
    return undefined;
  }

  const date = new Date(candidate.trim());

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

export class GeminiSourceAdapter implements SourceAdapter {
  public readonly id = 'gemini' as const;
  public readonly capabilities = {
    fixedProviderRoots: ['google'],
  } as const;

  private readonly geminiDir: string;
  private readonly requireGeminiDir: boolean;

  public constructor(options: GeminiSourceAdapterOptions = {}) {
    this.geminiDir = options.geminiDir ?? defaultGeminiDir;
    this.requireGeminiDir = options.requireGeminiDir ?? false;
  }

  private getNormalizedGeminiDir(): string {
    if (isBlankText(this.geminiDir)) {
      throw new Error('Gemini directory must be a non-empty path');
    }

    return this.geminiDir.trim();
  }

  private async getProjectMappingForParse(): Promise<Map<string, string>> {
    if (isBlankText(this.geminiDir)) {
      return new Map();
    }

    return await loadProjectsJson(this.geminiDir.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    const normalizedDir = this.getNormalizedGeminiDir();

    if (this.requireGeminiDir && !(await pathReadable(normalizedDir))) {
      throw new Error(`Gemini directory is missing or unreadable: ${normalizedDir}`);
    }

    if (this.requireGeminiDir && !(await pathIsDirectory(normalizedDir))) {
      throw new Error(`Gemini directory is not a directory: ${normalizedDir}`);
    }

    return discoverSessionFiles(normalizedDir);
  }

  public async getParseDependencies(): Promise<string[]> {
    if (isBlankText(this.geminiDir)) {
      return [];
    }

    return [getProjectsJsonPath(this.getNormalizedGeminiDir())];
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);

    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();

    let sessionData: unknown;

    try {
      const content = await readFile(filePath, 'utf8');
      sessionData = JSON.parse(content) as unknown;
    } catch {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'json_parse_error');

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const sessionDataRecord = asRecord(sessionData);

    if (!sessionDataRecord) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_session_data');

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const sessionId =
      asTrimmedText(sessionDataRecord.sessionId) ?? path.basename(filePath, '.json');

    const projectMapping = await this.getProjectMappingForParse();
    const repoRoot = resolveRepoRoot(filePath, sessionDataRecord, projectMapping);

    if (!Array.isArray(sessionDataRecord.messages)) {
      skippedRows++;
      incrementSkippedReason(skippedRowReasons, 'invalid_messages_array');
      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    }

    const messages = sessionDataRecord.messages;

    for (const rawMessage of messages) {
      const message = asRecord(rawMessage);

      if (!message) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_message');

        continue;
      }

      if (message.type !== 'gemini') {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'non_gemini_message');

        continue;
      }

      const tokens = extractTokenUsage(asRecord(message.tokens));

      if (!tokens) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'no_token_usage');

        continue;
      }

      const timestamp = normalizeTimestamp(message.timestamp);

      if (!timestamp) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');

        continue;
      }

      const model = asTrimmedText(message.model);

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId,
            timestamp,
            repoRoot,
            provider: 'google',
            model,
            ...tokens,
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
}

export function getDefaultGeminiDir(): string {
  return defaultGeminiDir;
}
