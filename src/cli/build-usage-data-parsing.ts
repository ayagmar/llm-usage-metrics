import { stat } from 'node:fs/promises';

import type { UsageEvent } from '../domain/usage-event.js';
import { matchesCanonicalProviderFilter } from '../domain/provider-normalization.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type {
  SourceAdapter,
  SourceParseFileDiagnostics,
  SourceSkippedRowReasonStat,
} from '../sources/source-adapter.js';
import { normalizeSkippedRowReasons } from './normalize-skipped-row-reasons.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import {
  getDefaultParseFileCachePath,
  getSourceShardedParseFileCachePath,
  type ParseDependencyFingerprint,
  ParseFileCache,
} from './parse-file-cache.js';
import type { RuntimeProfileCollector } from './runtime-profile.js';

import type { UsageSourceFailure } from './usage-data-contracts.js';

export type AdapterParseResult = {
  source: string;
  events: UsageEvent[];
  filesFound: number;
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

export type ParsedAdaptersResult = {
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
};

export type ParseCacheRuntimeConfig = {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
};

export type ParseSelectedAdaptersOptions = {
  parseCache?: ParseCacheRuntimeConfig;
  parseCacheFilePath?: string;
  now?: () => number;
  runtimeProfile?: RuntimeProfileCollector;
};

type RunWithParseBudget = <T>(task: () => Promise<T>) => Promise<T>;

function getDefaultParseFileDiagnostics(events: UsageEvent[]): SourceParseFileDiagnostics {
  return { events, skippedRows: 0, skippedRowReasons: [] };
}

function normalizeSkippedRowsCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function createParseDependencyFingerprint(
  filePath: string,
  options: { allowMissing: boolean },
): Promise<ParseDependencyFingerprint | undefined> {
  try {
    const fileStat = await stat(filePath);

    return {
      path: filePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (error) {
    if (options.allowMissing && isMissingPathError(error)) {
      return {
        path: filePath,
        exists: false,
      };
    }

    return undefined;
  }
}

async function getParseFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
): Promise<{ dependencies: ParseDependencyFingerprint[] } | undefined> {
  const primaryFingerprint = await createParseDependencyFingerprint(filePath, {
    allowMissing: false,
  });

  if (!primaryFingerprint) {
    return undefined;
  }

  const additionalDependencyPaths = adapter.getParseDependencies
    ? await adapter.getParseDependencies(filePath)
    : [];
  const uniqueAdditionalDependencyPaths = [...new Set(additionalDependencyPaths)]
    .filter((dependencyPath) => dependencyPath !== filePath)
    .sort(compareByCodePoint);
  const dependencyFingerprints: ParseDependencyFingerprint[] = [primaryFingerprint];

  for (const dependencyPath of uniqueAdditionalDependencyPaths) {
    const dependencyFingerprint = await createParseDependencyFingerprint(dependencyPath, {
      allowMissing: true,
    });

    if (!dependencyFingerprint) {
      return undefined;
    }

    dependencyFingerprints.push(dependencyFingerprint);
  }

  return {
    dependencies: dependencyFingerprints,
  };
}

function createParseBudget(maxParallelFileParsing: number): RunWithParseBudget {
  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  let availablePermits = safeMaxParallelFileParsing;
  const waitingResolvers: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (availablePermits > 0) {
      availablePermits -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      waitingResolvers.push(resolve);
    });
  }

  function release(): void {
    const nextResolver = waitingResolvers.shift();

    if (nextResolver) {
      nextResolver();
      return;
    }

    availablePermits += 1;
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();

    try {
      return await task();
    } finally {
      release();
    }
  };
}

export async function parseAdapterEvents(
  adapter: SourceAdapter,
  maxParallelFileParsing: number,
  runWithParseBudget: RunWithParseBudget = async <T>(task: () => Promise<T>) => task(),
  parseFileCache?: ParseFileCache,
  runtimeProfile?: RuntimeProfileCollector,
): Promise<AdapterParseResult> {
  const files = await adapter.discoverFiles();

  if (files.length === 0) {
    return {
      source: adapter.id,
      events: [],
      filesFound: 0,
      skippedRows: 0,
      skippedRowReasons: [],
    };
  }

  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  const parsedByFile: UsageEvent[][] = Array.from({ length: files.length }, () => []);
  const skippedRowsByFile: number[] = Array.from({ length: files.length }, () => 0);
  const skippedRowReasons = new Map<string, number>();
  const workerCount = Math.min(safeMaxParallelFileParsing, files.length);
  let nextFileIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextFileIndex < files.length) {
      const fileIndex = nextFileIndex;
      nextFileIndex += 1;

      await runWithParseBudget(async () => {
        const filePath = files[fileIndex];
        let fileFingerprint: { dependencies: ParseDependencyFingerprint[] } | undefined;
        let parseFileDiagnostics: SourceParseFileDiagnostics | undefined;

        if (parseFileCache) {
          fileFingerprint = await getParseFileFingerprint(adapter, filePath);

          if (fileFingerprint) {
            parseFileDiagnostics = parseFileCache.get(adapter.id, filePath, fileFingerprint);
            runtimeProfile?.recordParseCacheResult(
              adapter.id,
              parseFileDiagnostics ? 'hit' : 'miss',
            );
          }
        }

        if (!parseFileDiagnostics) {
          parseFileDiagnostics = adapter.parseFileWithDiagnostics
            ? await adapter.parseFileWithDiagnostics(filePath)
            : getDefaultParseFileDiagnostics(await adapter.parseFile(filePath));
          if (parseFileCache && fileFingerprint) {
            parseFileCache.set(adapter.id, filePath, fileFingerprint, parseFileDiagnostics);
          }
        }

        parsedByFile[fileIndex] = parseFileDiagnostics.events;
        skippedRowsByFile[fileIndex] = normalizeSkippedRowsCount(parseFileDiagnostics.skippedRows);
        for (const reasonStat of normalizeSkippedRowReasons(
          parseFileDiagnostics.skippedRowReasons,
        )) {
          skippedRowReasons.set(
            reasonStat.reason,
            (skippedRowReasons.get(reasonStat.reason) ?? 0) + reasonStat.count,
          );
        }
      });
    }
  });

  await Promise.all(workers);

  const result = {
    source: adapter.id,
    events: parsedByFile.flat(),
    filesFound: files.length,
    skippedRows: skippedRowsByFile.reduce((sum, skippedRowsCount) => sum + skippedRowsCount, 0),
    skippedRowReasons: [...skippedRowReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => compareByCodePoint(left.reason, right.reason)),
  };

  runtimeProfile?.recordParseResult(adapter.id, {
    filesFound: result.filesFound,
    eventsParsed: result.events.length,
  });

  return result;
}

function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function parseSelectedAdapters(
  adaptersToParse: SourceAdapter[],
  maxParallelFileParsing: number,
  options: ParseSelectedAdaptersOptions = {},
): Promise<ParsedAdaptersResult> {
  const runWithParseBudget = createParseBudget(maxParallelFileParsing);
  const parseCacheBySource = new Map<string, ParseFileCache>();

  if (options.parseCache?.enabled) {
    const parseCacheLimits = {
      ttlMs: options.parseCache.ttlMs,
      maxEntries: options.parseCache.maxEntries,
      maxBytes: options.parseCache.maxBytes,
    };
    const cacheFilePath = options.parseCacheFilePath ?? getDefaultParseFileCachePath();
    const sourceIds = [...new Set(adaptersToParse.map((adapter) => adapter.id.toLowerCase()))];

    await Promise.all(
      sourceIds.map(async (sourceId) => {
        parseCacheBySource.set(
          sourceId,
          await ParseFileCache.load({
            cacheFilePath: getSourceShardedParseFileCachePath(cacheFilePath, sourceId),
            limits: parseCacheLimits,
            now: options.now,
          }),
        );
      }),
    );
  }

  const parseResults = await Promise.allSettled(
    adaptersToParse.map((adapter) =>
      options.runtimeProfile
        ? options.runtimeProfile.measure(`parse.adapter.${adapter.id}`, () =>
            parseAdapterEvents(
              adapter,
              maxParallelFileParsing,
              runWithParseBudget,
              parseCacheBySource.get(adapter.id.toLowerCase()),
              options.runtimeProfile,
            ),
          )
        : parseAdapterEvents(
            adapter,
            maxParallelFileParsing,
            runWithParseBudget,
            parseCacheBySource.get(adapter.id.toLowerCase()),
          ),
    ),
  );

  if (parseCacheBySource.size > 0) {
    await Promise.allSettled(
      [...parseCacheBySource.values()].map(async (parseCache) => parseCache.persist()),
    );
  }

  const sourceFailures: UsageSourceFailure[] = [];
  const successfulParseResults: AdapterParseResult[] = [];

  for (const [index, parseResult] of parseResults.entries()) {
    const source = adaptersToParse[index].id;

    if (parseResult.status === 'fulfilled') {
      successfulParseResults.push(parseResult.value);
      continue;
    }

    sourceFailures.push({ source, reason: getErrorReason(parseResult.reason) });
  }

  return {
    successfulParseResults,
    sourceFailures,
  };
}

export function throwOnExplicitSourceFailures(
  sourceFailures: UsageSourceFailure[],
  explicitSourceIds: ReadonlySet<string>,
): void {
  const explicitFailures = sourceFailures.filter((failure) =>
    explicitSourceIds.has(failure.source.toLowerCase()),
  );

  if (explicitFailures.length === 0) {
    return;
  }

  const details = explicitFailures
    .map((failure) => `${failure.source}: ${failure.reason}`)
    .join('; ');

  throw new Error(`Failed to parse explicitly requested source(s): ${details}`);
}

function isEventWithinDateRange(
  event: UsageEvent,
  timezone: string,
  since: string | undefined,
  until: string | undefined,
): boolean {
  const eventDate = getPeriodKey(event.timestamp, 'daily', timezone);

  if (since && eventDate < since) {
    return false;
  }

  if (until && eventDate > until) {
    return false;
  }

  return true;
}

type ModelFilterRule = {
  value: string;
  mode: 'exact' | 'substring';
};

function resolveModelFilterRules(
  events: UsageEvent[],
  modelFilter: string[] | undefined,
): ModelFilterRule[] | undefined {
  if (!modelFilter || modelFilter.length === 0) {
    return undefined;
  }

  const availableModels = new Set(
    events
      .map((event) => event.model?.toLowerCase())
      .filter((model): model is string => Boolean(model)),
  );

  return modelFilter.map((value) => ({
    value,
    mode: availableModels.has(value) ? 'exact' : 'substring',
  }));
}

function matchesModel(
  model: string | undefined,
  modelRules: ModelFilterRule[] | undefined,
): boolean {
  if (!modelRules || modelRules.length === 0) {
    return true;
  }

  if (!model) {
    return false;
  }

  const normalizedModel = model.toLowerCase();

  return modelRules.some((rule) =>
    rule.mode === 'exact' ? normalizedModel === rule.value : normalizedModel.includes(rule.value),
  );
}

export type UsageEventFilterOptions = {
  timezone: string;
  since?: string;
  until?: string;
  providerFilter?: string;
  modelFilter?: string[];
};

function filterByModelRules(events: UsageEvent[], modelFilter: string[] | undefined): UsageEvent[] {
  const modelFilterRules = resolveModelFilterRules(events, modelFilter);

  return events.filter((event) => matchesModel(event.model, modelFilterRules));
}

function collectProviderAndDateFilteredEvents(
  eventGroups: Iterable<readonly UsageEvent[]>,
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const filteredEvents: UsageEvent[] = [];

  for (const events of eventGroups) {
    for (const event of events) {
      if (!matchesCanonicalProviderFilter(event.provider, options.providerFilter)) {
        continue;
      }

      if (!isEventWithinDateRange(event, options.timezone, options.since, options.until)) {
        continue;
      }

      filteredEvents.push(event);
    }
  }

  return filteredEvents;
}

export function filterUsageEvents(
  events: UsageEvent[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents([events], options);
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}

export function filterParsedAdapterEvents(
  parseResults: AdapterParseResult[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents(
    parseResults.map((result) => result.events),
    options,
  );
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}
