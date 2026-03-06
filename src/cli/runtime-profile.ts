import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { logger } from '../utils/logger.js';

export const RUNTIME_PROFILE_ENV_VAR = 'LLM_USAGE_PROFILE_RUNTIME';

export type RuntimeProfileLogger = Pick<typeof logger, 'info' | 'warn' | 'dim'>;

export type RuntimeProfileSourceSelection = {
  availableSourceIds: string[];
  selectedSourceIds: string[];
  candidateProviderRoots?: string[];
};

export type RuntimeProfileSourceStats = {
  source: string;
  filesFound: number;
  eventsParsed: number;
  cacheHits: number;
  cacheMisses: number;
};

export type RuntimeProfileStageTiming = {
  name: string;
  durationMs: number;
};

export type RuntimeProfileSnapshot = {
  sourceSelection?: RuntimeProfileSourceSelection;
  parseCache: {
    hits: number;
    misses: number;
  };
  parseTotals: {
    filesFound: number;
    eventsParsed: number;
  };
  sourceStats: RuntimeProfileSourceStats[];
  stageTimings: RuntimeProfileStageTiming[];
};

type MutableRuntimeProfileSourceStats = RuntimeProfileSourceStats;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue.length === 0) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalizedValue);
}

export function isRuntimeProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env[RUNTIME_PROFILE_ENV_VAR]);
}

export class RuntimeProfileCollector {
  private sourceSelection: RuntimeProfileSourceSelection | undefined;
  private readonly sourceStats = new Map<string, MutableRuntimeProfileSourceStats>();
  private readonly stageDurations = new Map<string, number>();

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public async measure<T>(name: string, task: () => Promise<T>): Promise<T> {
    const startedAt = this.now();

    try {
      return await task();
    } finally {
      this.recordStageDuration(name, this.now() - startedAt);
    }
  }

  public measureSync<T>(name: string, task: () => T): T {
    const startedAt = this.now();

    try {
      return task();
    } finally {
      this.recordStageDuration(name, this.now() - startedAt);
    }
  }

  public recordStageDuration(name: string, durationMs: number): void {
    if (!name || !Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    this.stageDurations.set(name, (this.stageDurations.get(name) ?? 0) + durationMs);
  }

  public recordSourceSelection(selection: RuntimeProfileSourceSelection): void {
    this.sourceSelection = {
      availableSourceIds: [...selection.availableSourceIds],
      selectedSourceIds: [...selection.selectedSourceIds],
      candidateProviderRoots: selection.candidateProviderRoots
        ? [...selection.candidateProviderRoots]
        : undefined,
    };
  }

  public recordParseCacheResult(source: string, result: 'hit' | 'miss'): void {
    const sourceStats = this.getOrCreateSourceStats(source);

    if (result === 'hit') {
      sourceStats.cacheHits += 1;
      return;
    }

    sourceStats.cacheMisses += 1;
  }

  public recordParseResult(
    source: string,
    result: {
      filesFound: number;
      eventsParsed: number;
    },
  ): void {
    const sourceStats = this.getOrCreateSourceStats(source);
    sourceStats.filesFound += Math.max(0, Math.trunc(result.filesFound));
    sourceStats.eventsParsed += Math.max(0, Math.trunc(result.eventsParsed));
  }

  public snapshot(): RuntimeProfileSnapshot {
    const sourceStats = [...this.sourceStats.values()].sort((left, right) =>
      compareByCodePoint(left.source, right.source),
    );
    const parseTotals = sourceStats.reduce(
      (totals, source) => ({
        filesFound: totals.filesFound + source.filesFound,
        eventsParsed: totals.eventsParsed + source.eventsParsed,
      }),
      { filesFound: 0, eventsParsed: 0 },
    );
    const parseCache = sourceStats.reduce(
      (totals, source) => ({
        hits: totals.hits + source.cacheHits,
        misses: totals.misses + source.cacheMisses,
      }),
      { hits: 0, misses: 0 },
    );
    const stageTimings = [...this.stageDurations.entries()]
      .sort(([leftName], [rightName]) => compareByCodePoint(leftName, rightName))
      .map(([name, durationMs]) => ({ name, durationMs }));

    return {
      sourceSelection: this.sourceSelection
        ? {
            availableSourceIds: [...this.sourceSelection.availableSourceIds],
            selectedSourceIds: [...this.sourceSelection.selectedSourceIds],
            candidateProviderRoots: this.sourceSelection.candidateProviderRoots
              ? [...this.sourceSelection.candidateProviderRoots]
              : undefined,
          }
        : undefined,
      parseCache,
      parseTotals,
      sourceStats: sourceStats.map((source) => ({ ...source })),
      stageTimings,
    };
  }

  private getOrCreateSourceStats(source: string): MutableRuntimeProfileSourceStats {
    const existing = this.sourceStats.get(source);

    if (existing) {
      return existing;
    }

    const created: MutableRuntimeProfileSourceStats = {
      source,
      filesFound: 0,
      eventsParsed: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
    this.sourceStats.set(source, created);
    return created;
  }
}

export async function measureRuntimeProfileStage<T>(
  runtimeProfile: RuntimeProfileCollector | undefined,
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  if (!runtimeProfile) {
    return await task();
  }

  return await runtimeProfile.measure(name, task);
}

export function measureRuntimeProfileStageSync<T>(
  runtimeProfile: RuntimeProfileCollector | undefined,
  name: string,
  task: () => T,
): T {
  if (!runtimeProfile) {
    return task();
  }

  return runtimeProfile.measureSync(name, task);
}

export function createRuntimeProfileCollector(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProfileCollector | undefined {
  if (!isRuntimeProfileEnabled(env)) {
    return undefined;
  }

  return new RuntimeProfileCollector();
}

function hasRecordedSourceStats(snapshot: RuntimeProfileSnapshot): boolean {
  return snapshot.sourceStats.length > 0;
}

function hasRecordedParseCache(snapshot: RuntimeProfileSnapshot): boolean {
  return (
    snapshot.parseCache.hits > 0 ||
    snapshot.parseCache.misses > 0 ||
    hasRecordedSourceStats(snapshot)
  );
}

function hasRecordedParseTotals(snapshot: RuntimeProfileSnapshot): boolean {
  return (
    snapshot.parseTotals.filesFound > 0 ||
    snapshot.parseTotals.eventsParsed > 0 ||
    hasRecordedSourceStats(snapshot)
  );
}

export function mergeRuntimeProfiles(
  primary: RuntimeProfileSnapshot | undefined,
  fallback: RuntimeProfileSnapshot | undefined,
): RuntimeProfileSnapshot | undefined {
  if (!primary) {
    return fallback;
  }

  if (!fallback) {
    return primary;
  }

  const stageTimingsByName = new Map(
    fallback.stageTimings.map((stageTiming) => [stageTiming.name, stageTiming]),
  );

  for (const stageTiming of primary.stageTimings) {
    stageTimingsByName.set(stageTiming.name, stageTiming);
  }

  return {
    sourceSelection: primary.sourceSelection ?? fallback.sourceSelection,
    parseCache: hasRecordedParseCache(primary) ? primary.parseCache : fallback.parseCache,
    parseTotals: hasRecordedParseTotals(primary) ? primary.parseTotals : fallback.parseTotals,
    sourceStats: primary.sourceStats.length > 0 ? primary.sourceStats : fallback.sourceStats,
    stageTimings: [...stageTimingsByName.values()].sort((left, right) =>
      compareByCodePoint(left.name, right.name),
    ),
  };
}

export function emitRuntimeProfile(
  runtimeProfile: RuntimeProfileSnapshot | undefined,
  diagnosticsLogger: RuntimeProfileLogger = logger,
): void {
  if (!runtimeProfile) {
    return;
  }

  diagnosticsLogger.info('Runtime profile:');

  if (runtimeProfile.sourceSelection) {
    const candidateProviderRoots =
      runtimeProfile.sourceSelection.candidateProviderRoots &&
      runtimeProfile.sourceSelection.candidateProviderRoots.length > 0
        ? `; candidateProviderRoots=${runtimeProfile.sourceSelection.candidateProviderRoots.join(',')}`
        : '';

    diagnosticsLogger.dim(
      `  source selection: available=${runtimeProfile.sourceSelection.availableSourceIds.join(',')}; selected=${runtimeProfile.sourceSelection.selectedSourceIds.join(',')}${candidateProviderRoots}`,
    );
  }

  diagnosticsLogger.dim(
    `  parse cache: hits=${runtimeProfile.parseCache.hits}; misses=${runtimeProfile.parseCache.misses}`,
  );
  diagnosticsLogger.dim(
    `  parse totals: files=${runtimeProfile.parseTotals.filesFound}; events=${runtimeProfile.parseTotals.eventsParsed}`,
  );

  for (const source of runtimeProfile.sourceStats) {
    diagnosticsLogger.dim(
      `  source ${source.source}: files=${source.filesFound}; events=${source.eventsParsed}; cacheHits=${source.cacheHits}; cacheMisses=${source.cacheMisses}`,
    );
  }

  diagnosticsLogger.dim('  stage timings:');

  for (const stageTiming of runtimeProfile.stageTimings) {
    diagnosticsLogger.dim(`    ${stageTiming.name}: ${stageTiming.durationMs.toFixed(2)}ms`);
  }
}
