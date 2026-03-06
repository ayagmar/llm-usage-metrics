import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeProfileCollector,
  emitRuntimeProfile,
  isRuntimeProfileEnabled,
  measureRuntimeProfileStage,
  measureRuntimeProfileStageSync,
  mergeRuntimeProfiles,
  RuntimeProfileCollector,
  type RuntimeProfileLogger,
} from '../../src/cli/runtime-profile.js';

function createLoggerSpy(): RuntimeProfileLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    dim: vi.fn(),
  };
}

describe('runtime-profile', () => {
  it('emits source selection, parse cache, parse counts, and stage timings', async () => {
    const profile = new RuntimeProfileCollector(() => 100);
    profile.recordSourceSelection({
      availableSourceIds: ['pi', 'codex', 'gemini'],
      selectedSourceIds: ['pi', 'codex'],
      candidateProviderRoots: ['openai'],
    });
    profile.recordParseCacheResult('pi', 'hit');
    profile.recordParseCacheResult('codex', 'miss');
    profile.recordParseResult('pi', { filesFound: 2, eventsParsed: 5 });
    profile.recordParseResult('codex', { filesFound: 1, eventsParsed: 3 });
    profile.recordStageDuration('usage.dataset.parse', 12.34);
    profile.recordStageDuration('usage.pricing.apply', 4.56);

    const diagnosticsLogger = createLoggerSpy();
    emitRuntimeProfile(profile.snapshot(), diagnosticsLogger);

    expect(diagnosticsLogger.info).toHaveBeenCalledWith('Runtime profile:');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith(
      '  source selection: available=pi,codex,gemini; selected=pi,codex; candidateProviderRoots=openai',
    );
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('  parse cache: hits=1; misses=1');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('  parse totals: files=3; events=8');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith(
      '  source codex: files=1; events=3; cacheHits=0; cacheMisses=1',
    );
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith(
      '  source pi: files=2; events=5; cacheHits=1; cacheMisses=0',
    );
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('  stage timings:');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('    usage.dataset.parse: 12.34ms');
    expect(diagnosticsLogger.dim).toHaveBeenCalledWith('    usage.pricing.apply: 4.56ms');
    expect(diagnosticsLogger.warn).not.toHaveBeenCalled();
  });

  it('merges collector and diagnostics snapshots without dropping populated sections', () => {
    const merged = mergeRuntimeProfiles(
      {
        parseCache: {
          hits: 0,
          misses: 0,
        },
        parseTotals: {
          filesFound: 0,
          eventsParsed: 0,
        },
        sourceStats: [],
        stageTimings: [{ name: 'report.prepare.render', durationMs: 1.23 }],
      },
      {
        sourceSelection: {
          availableSourceIds: ['pi', 'codex'],
          selectedSourceIds: ['codex'],
          candidateProviderRoots: ['openai'],
        },
        parseCache: {
          hits: 1,
          misses: 0,
        },
        parseTotals: {
          filesFound: 1,
          eventsParsed: 2,
        },
        sourceStats: [
          {
            source: 'codex',
            filesFound: 1,
            eventsParsed: 2,
            cacheHits: 1,
            cacheMisses: 0,
          },
        ],
        stageTimings: [{ name: 'optimize.dataset.total', durationMs: 4.56 }],
      },
    );

    expect(merged).toEqual({
      sourceSelection: {
        availableSourceIds: ['pi', 'codex'],
        selectedSourceIds: ['codex'],
        candidateProviderRoots: ['openai'],
      },
      parseCache: {
        hits: 1,
        misses: 0,
      },
      parseTotals: {
        filesFound: 1,
        eventsParsed: 2,
      },
      sourceStats: [
        {
          source: 'codex',
          filesFound: 1,
          eventsParsed: 2,
          cacheHits: 1,
          cacheMisses: 0,
        },
      ],
      stageTimings: [
        { name: 'optimize.dataset.total', durationMs: 4.56 },
        { name: 'report.prepare.render', durationMs: 1.23 },
      ],
    });
  });

  it('supports disabled profiling and direct stage helpers without a collector', async () => {
    expect(isRuntimeProfileEnabled({ LLM_USAGE_PROFILE_RUNTIME: '   ' })).toBe(false);
    expect(createRuntimeProfileCollector({ LLM_USAGE_PROFILE_RUNTIME: '1' })).toBeInstanceOf(
      RuntimeProfileCollector,
    );
    expect(createRuntimeProfileCollector({})).toBeUndefined();

    await expect(measureRuntimeProfileStage(undefined, 'unused', async () => 'ok')).resolves.toBe(
      'ok',
    );
    expect(measureRuntimeProfileStageSync(undefined, 'unused', () => 'sync')).toBe('sync');
  });

  it('returns whichever runtime profile snapshot is available and skips empty emission', () => {
    const snapshot = {
      parseCache: { hits: 0, misses: 0 },
      parseTotals: { filesFound: 0, eventsParsed: 0 },
      sourceStats: [],
      stageTimings: [],
    };

    expect(mergeRuntimeProfiles(snapshot, undefined)).toBe(snapshot);
    expect(mergeRuntimeProfiles(undefined, snapshot)).toBe(snapshot);

    const diagnosticsLogger = createLoggerSpy();
    emitRuntimeProfile(undefined, diagnosticsLogger);
    expect(diagnosticsLogger.info).not.toHaveBeenCalled();
    expect(diagnosticsLogger.dim).not.toHaveBeenCalled();
  });
});
