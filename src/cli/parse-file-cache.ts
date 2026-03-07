import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeSourceId, type UsageEvent } from '../domain/usage-event.js';
import { normalizeProviderToBillingEntity } from '../domain/provider-normalization.js';
import type {
  SourceParseFileDiagnostics,
  SourceSkippedRowReasonStat,
} from '../sources/source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { normalizeSkippedRowReasons } from './normalize-skipped-row-reasons.js';
import { asRecord } from '../utils/as-record.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';

const PARSE_FILE_CACHE_VERSION = 5;
const CACHE_KEY_SEPARATOR = '\u0000';

export type ParseDependencyFingerprint = {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
};

export type ParseFileFingerprint = {
  size?: number;
  mtimeMs?: number;
  dependencies?: ParseDependencyFingerprint[];
};

export type ParseFileCacheLimits = {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
};

type ParseFileCacheEntry = {
  source: string;
  filePath: string;
  fingerprint: NormalizedParseFileFingerprint;
  cachedAt: number;
  diagnostics: SourceParseFileDiagnostics;
};

type ParseFileCachePayload = {
  version: number;
  entries: ParseFileCacheEntry[];
};

type NormalizedParseFileFingerprint = {
  dependencies: ParseDependencyFingerprint[];
};

function createCacheKey(source: string, filePath: string): string {
  return `${source}${CACHE_KEY_SEPARATOR}${filePath}`;
}

function normalizeCacheSource(source: string): string {
  return normalizeSourceId(source)?.toLowerCase() ?? '';
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function normalizeCachedTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const timestamp = new Date(normalized);

  if (Number.isNaN(timestamp.getTime())) {
    return undefined;
  }

  return timestamp.toISOString() === normalized ? normalized : undefined;
}

function normalizeCachedUsageEvent(value: unknown): UsageEvent | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const source = normalizeSourceId(record.source)?.toLowerCase();
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  const timestamp = normalizeCachedTimestamp(record.timestamp);
  const repoRoot = typeof record.repoRoot === 'string' ? record.repoRoot.trim() : '';

  if (!source || !sessionId || !timestamp) {
    return undefined;
  }

  const costMode =
    record.costMode === 'explicit' || record.costMode === 'estimated' ? record.costMode : undefined;

  if (!costMode) {
    return undefined;
  }

  const inputTokens = toNonNegativeInteger(record.inputTokens);
  const outputTokens = toNonNegativeInteger(record.outputTokens);
  const reasoningTokens = toNonNegativeInteger(record.reasoningTokens);
  const cacheReadTokens = toNonNegativeInteger(record.cacheReadTokens);
  const cacheWriteTokens = toNonNegativeInteger(record.cacheWriteTokens);
  const totalTokens = toNonNegativeInteger(record.totalTokens);

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const provider = normalizeProviderToBillingEntity(
    typeof record.provider === 'string' ? record.provider : undefined,
  );
  const model = typeof record.model === 'string' ? record.model.trim().toLowerCase() : '';
  const costUsd = toNonNegativeNumber(record.costUsd);

  if (costMode === 'explicit' && costUsd === undefined) {
    return undefined;
  }

  return {
    source,
    sessionId,
    timestamp,
    repoRoot: repoRoot || undefined,
    provider,
    model: model || undefined,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    costMode,
  };
}

function cloneUsageEvent(event: UsageEvent): UsageEvent {
  return { ...event };
}

function cloneUsageEvents(events: UsageEvent[]): UsageEvent[] {
  return events.map((event) => cloneUsageEvent(event));
}

function cloneSkippedRowReasons(
  skippedRowReasons: SourceSkippedRowReasonStat[] | undefined,
): SourceSkippedRowReasonStat[] {
  return (skippedRowReasons ?? []).map((stat) => ({ reason: stat.reason, count: stat.count }));
}

function normalizeCachedEvents(value: unknown): UsageEvent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalizedEvents: UsageEvent[] = [];

  for (const event of value) {
    const normalizedEvent = normalizeCachedUsageEvent(event);

    if (!normalizedEvent) {
      return undefined;
    }

    normalizedEvents.push(normalizedEvent);
  }

  return normalizedEvents;
}

function normalizeFingerprintPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeParseDependencyFingerprint(
  value: unknown,
): ParseDependencyFingerprint | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const dependencyPath = normalizeFingerprintPath(record.path);
  const exists = typeof record.exists === 'boolean' ? record.exists : undefined;

  if (!dependencyPath || exists === undefined) {
    return undefined;
  }

  if (!exists) {
    return {
      path: dependencyPath,
      exists: false,
    };
  }

  const size = toNonNegativeInteger(record.size);
  const mtimeMs = toNonNegativeNumber(record.mtimeMs);

  if (size === undefined || mtimeMs === undefined) {
    return undefined;
  }

  return {
    path: dependencyPath,
    exists: true,
    size,
    mtimeMs,
  };
}

function compareDependencyFingerprint(
  left: ParseDependencyFingerprint,
  right: ParseDependencyFingerprint,
): number {
  if (left.path !== right.path) {
    return compareByCodePoint(left.path, right.path);
  }

  if (left.exists !== right.exists) {
    return left.exists ? 1 : -1;
  }

  if ((left.size ?? -1) !== (right.size ?? -1)) {
    return (left.size ?? -1) - (right.size ?? -1);
  }

  return (left.mtimeMs ?? -1) - (right.mtimeMs ?? -1);
}

function normalizeRuntimeFingerprint(
  filePath: string,
  fingerprint: unknown,
): NormalizedParseFileFingerprint | undefined {
  const fingerprintRecord = asRecord(fingerprint);

  if (!fingerprintRecord) {
    return undefined;
  }

  if ('dependencies' in fingerprintRecord && !Array.isArray(fingerprintRecord.dependencies)) {
    return undefined;
  }

  if (Array.isArray(fingerprintRecord.dependencies)) {
    const normalizedDependencies: ParseDependencyFingerprint[] = [];

    for (const dependency of fingerprintRecord.dependencies) {
      const normalizedDependency = normalizeParseDependencyFingerprint(dependency);

      if (!normalizedDependency) {
        return undefined;
      }

      normalizedDependencies.push(normalizedDependency);
    }

    if (normalizedDependencies.length === 0) {
      return undefined;
    }

    normalizedDependencies.sort(compareDependencyFingerprint);

    return {
      dependencies: normalizedDependencies,
    };
  }

  const size = toNonNegativeInteger(fingerprintRecord.size);
  const mtimeMs = toNonNegativeNumber(fingerprintRecord.mtimeMs);

  if (size === undefined || mtimeMs === undefined) {
    return undefined;
  }

  return {
    dependencies: [
      {
        path: filePath,
        exists: true,
        size,
        mtimeMs,
      },
    ],
  };
}

function normalizeCacheEntry(value: unknown): ParseFileCacheEntry | undefined {
  const record = asRecord(value);

  if (!record) {
    return undefined;
  }

  const source = normalizeSourceId(record.source)?.toLowerCase() ?? '';
  const filePath = typeof record.filePath === 'string' ? record.filePath.trim() : '';
  const cachedAt = toNonNegativeInteger(record.cachedAt);
  const fingerprint = normalizeRuntimeFingerprint(filePath, record.fingerprint);
  const diagnostics = asRecord(record.diagnostics);
  const skippedRows = toNonNegativeInteger(diagnostics?.skippedRows) ?? 0;
  const events = normalizeCachedEvents(diagnostics?.events);

  if (!source || !filePath || !fingerprint || cachedAt === undefined) {
    return undefined;
  }

  if (!events) {
    return undefined;
  }

  return {
    source,
    filePath,
    fingerprint,
    cachedAt,
    diagnostics: {
      events,
      skippedRows,
      skippedRowReasons: normalizeSkippedRowReasons(diagnostics?.skippedRowReasons),
    },
  };
}

export function getDefaultParseFileCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'parse-file-cache.json');
}

function normalizeCacheShardSource(source: string): string {
  const normalizedSource = normalizeCacheSource(source);

  if (!normalizedSource) {
    return 'unknown';
  }

  return normalizedSource.replace(/[^a-z0-9._-]/gu, '_');
}

export function getSourceShardedParseFileCachePath(cacheFilePath: string, source: string): string {
  const parsedPath = path.parse(cacheFilePath);
  const sourceShard = normalizeCacheShardSource(source);

  if (parsedPath.ext.length > 0) {
    return path.join(parsedPath.dir, `${parsedPath.name}.${sourceShard}${parsedPath.ext}`);
  }

  return path.join(parsedPath.dir, `${parsedPath.base}.${sourceShard}`);
}

export class ParseFileCache {
  private readonly entriesByKey = new Map<string, ParseFileCacheEntry>();
  private dirty = false;

  private constructor(
    private readonly cacheFilePath: string,
    private readonly limits: ParseFileCacheLimits,
    private readonly now: () => number,
  ) {}

  public static async load(options: {
    cacheFilePath?: string;
    limits: ParseFileCacheLimits;
    now?: () => number;
  }): Promise<ParseFileCache> {
    const cache = new ParseFileCache(
      options.cacheFilePath ?? getDefaultParseFileCachePath(),
      options.limits,
      options.now ?? Date.now,
    );
    await cache.loadFromDisk();
    return cache;
  }

  public get(
    source: string,
    filePath: string,
    fingerprint: ParseFileFingerprint,
  ): SourceParseFileDiagnostics | undefined {
    const normalizedSource = normalizeCacheSource(source);
    const cacheKey = createCacheKey(normalizedSource, filePath);
    const entry = this.entriesByKey.get(cacheKey);

    if (!entry) {
      return undefined;
    }

    if (entry.cachedAt + this.limits.ttlMs < this.now()) {
      this.entriesByKey.delete(cacheKey);
      this.dirty = true;
      return undefined;
    }

    const normalizedFingerprint = normalizeRuntimeFingerprint(filePath, fingerprint);

    if (!normalizedFingerprint) {
      return undefined;
    }

    if (
      entry.fingerprint.dependencies.length !== normalizedFingerprint.dependencies.length ||
      entry.fingerprint.dependencies.some((dependency, index) => {
        const candidate = normalizedFingerprint.dependencies[index];

        return (
          dependency.path !== candidate.path ||
          dependency.exists !== candidate.exists ||
          dependency.size !== candidate.size ||
          dependency.mtimeMs !== candidate.mtimeMs
        );
      })
    ) {
      this.entriesByKey.delete(cacheKey);
      this.dirty = true;
      return undefined;
    }

    return {
      events: cloneUsageEvents(entry.diagnostics.events),
      skippedRows: entry.diagnostics.skippedRows,
      skippedRowReasons: cloneSkippedRowReasons(entry.diagnostics.skippedRowReasons),
    };
  }

  public set(
    source: string,
    filePath: string,
    fingerprint: ParseFileFingerprint,
    diagnostics: SourceParseFileDiagnostics,
  ): void {
    const normalizedSource = normalizeCacheSource(source);
    const normalizedFingerprint = normalizeRuntimeFingerprint(filePath, fingerprint);

    if (!normalizedFingerprint) {
      return;
    }

    this.entriesByKey.set(createCacheKey(normalizedSource, filePath), {
      source: normalizedSource,
      filePath,
      fingerprint: normalizedFingerprint,
      cachedAt: this.now(),
      diagnostics: {
        events: cloneUsageEvents(diagnostics.events),
        skippedRows: diagnostics.skippedRows,
        skippedRowReasons: cloneSkippedRowReasons(diagnostics.skippedRowReasons),
      },
    });
    this.dirty = true;
  }

  public async persist(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    const sortedEntries = [...this.entriesByKey.values()]
      .filter((entry) => entry.cachedAt + this.limits.ttlMs >= this.now())
      .sort((left, right) => right.cachedAt - left.cachedAt);

    const keptEntries = sortedEntries.slice(0, this.limits.maxEntries);
    let payloadText = JSON.stringify(this.toPayload(keptEntries));

    if (Buffer.byteLength(payloadText, 'utf8') > this.limits.maxBytes) {
      let bestCount = 0;
      let bestPayloadText = JSON.stringify(this.toPayload([]));
      let low = 0;
      let high = keptEntries.length;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidateText = JSON.stringify(this.toPayload(keptEntries.slice(0, mid)));

        if (Buffer.byteLength(candidateText, 'utf8') <= this.limits.maxBytes) {
          bestCount = mid;
          bestPayloadText = candidateText;
          low = mid + 1;
          continue;
        }

        high = mid - 1;
      }

      keptEntries.length = bestCount;
      payloadText = bestPayloadText;
    }

    await mkdir(path.dirname(this.cacheFilePath), { recursive: true });
    const temporaryPath = `${this.cacheFilePath}.${process.pid}.${this.now()}.tmp`;

    try {
      await writeFile(temporaryPath, payloadText, 'utf8');
      await rename(temporaryPath, this.cacheFilePath);
      this.replaceEntries(keptEntries);
      this.dirty = false;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private toPayload(entries: ParseFileCacheEntry[]): ParseFileCachePayload {
    return {
      version: PARSE_FILE_CACHE_VERSION,
      entries: entries.map((entry) => ({
        source: entry.source,
        filePath: entry.filePath,
        fingerprint: entry.fingerprint,
        cachedAt: entry.cachedAt,
        diagnostics: {
          events: entry.diagnostics.events,
          skippedRows: entry.diagnostics.skippedRows,
          skippedRowReasons: cloneSkippedRowReasons(entry.diagnostics.skippedRowReasons),
        },
      })),
    };
  }

  private replaceEntries(entries: ParseFileCacheEntry[]): void {
    this.entriesByKey.clear();

    for (const entry of entries) {
      this.entriesByKey.set(createCacheKey(entry.source, entry.filePath), entry);
    }
  }

  private async loadFromDisk(): Promise<void> {
    let cacheFileSizeBytes: number;

    try {
      const cacheStat = await stat(this.cacheFilePath);
      cacheFileSizeBytes = cacheStat.size;
    } catch {
      return;
    }

    if (cacheFileSizeBytes > this.limits.maxBytes) {
      this.dirty = true;
      return;
    }

    let content: string;

    try {
      content = await readFile(this.cacheFilePath, 'utf8');
    } catch {
      return;
    }

    let parsedPayload: unknown;

    try {
      parsedPayload = JSON.parse(content);
    } catch {
      this.dirty = true;
      return;
    }

    const payloadRecord = asRecord(parsedPayload);

    if (!payloadRecord) {
      this.dirty = true;
      return;
    }

    const version = toNonNegativeInteger(payloadRecord.version);

    if (version !== PARSE_FILE_CACHE_VERSION) {
      this.dirty = true;
      return;
    }

    if (Buffer.byteLength(content, 'utf8') > this.limits.maxBytes) {
      this.dirty = true;
      return;
    }

    const entries = Array.isArray(payloadRecord.entries) ? payloadRecord.entries : [];

    for (const rawEntry of entries) {
      const normalizedEntry = normalizeCacheEntry(rawEntry);

      if (!normalizedEntry) {
        this.dirty = true;
        continue;
      }

      if (normalizedEntry.cachedAt + this.limits.ttlMs < this.now()) {
        this.dirty = true;
        continue;
      }

      this.entriesByKey.set(
        createCacheKey(normalizedEntry.source, normalizedEntry.filePath),
        normalizedEntry,
      );
    }

    if (this.entriesByKey.size > this.limits.maxEntries) {
      const keptEntries = [...this.entriesByKey.values()]
        .sort((left, right) => right.cachedAt - left.cachedAt)
        .slice(0, this.limits.maxEntries);

      this.replaceEntries(keptEntries);
      this.dirty = true;
    }
  }
}
