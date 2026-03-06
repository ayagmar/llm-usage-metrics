import { describe, expect, it, vi } from 'vitest';

import { buildEfficiencyData } from '../../src/cli/build-efficiency-data.js';
import { RuntimeProfileCollector } from '../../src/cli/runtime-profile.js';
import type {
  UsageEventDataset,
  UsageEventDatasetPricingResult,
} from '../../src/cli/build-usage-event-dataset.js';
import type { UsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

type CollectGitOutcomesFn = (options: { activeUsageDays?: ReadonlySet<string> }) => Promise<{
  periodOutcomes: Map<
    string,
    { commitCount: number; linesAdded: number; linesDeleted: number; linesChanged: number }
  >;
  totalOutcomes: {
    commitCount: number;
    linesAdded: number;
    linesDeleted: number;
    linesChanged: number;
  };
  diagnostics: {
    repoDir: string;
    includeMergeCommits: boolean;
    commitsCollected: number;
    linesAdded: number;
    linesDeleted: number;
  };
}>;

function createAdapter(id: SourceAdapter['id']): SourceAdapter {
  return {
    id,
    discoverFiles: async () => [],
    parseFile: async () => [],
  };
}

function createPricedEvents(): [UsageEvent, UsageEvent, UsageEvent] {
  return [
    {
      source: 'pi',
      sessionId: 'pi-session-1',
      timestamp: '2026-02-11T12:00:00.000Z',
      repoRoot: '/workspace/repo-a/app',
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 120,
      outputTokens: 80,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 200,
      costUsd: 2,
      costMode: 'explicit',
    },
    {
      source: 'opencode',
      sessionId: 'opencode-session-1',
      timestamp: '2026-02-11T12:05:00.000Z',
      repoRoot: '/workspace/repo-b',
      provider: 'github-copilot',
      model: 'claude-opus-4.6',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 1.5,
      costMode: 'explicit',
    },
    {
      source: 'codex',
      sessionId: 'codex-session-1',
      timestamp: '2026-02-11T12:10:00.000Z',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      inputTokens: 60,
      outputTokens: 40,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 100,
      costUsd: 1,
      costMode: 'explicit',
    },
  ];
}

function createUsageEventDataset(options: Record<string, unknown> = {}): UsageEventDataset {
  const pricedEvents = createPricedEvents();
  const [piEvent, opencodeEvent, codexEvent] = pricedEvents;

  return {
    options,
    normalizedInputs: {
      timezone: 'Europe/Paris',
      providerFilter: undefined,
      candidateProviderRoots: undefined,
      sourceFilter: undefined,
      modelFilter: undefined,
      explicitSourceIds: new Set(),
      pricingUrl: undefined,
    },
    adaptersToParse: [createAdapter('pi'), createAdapter('opencode'), createAdapter('codex')],
    successfulParseResults: [
      {
        source: 'pi',
        events: [piEvent],
        filesFound: 1,
        skippedRows: 0,
        skippedRowReasons: [],
      },
      {
        source: 'opencode',
        events: [opencodeEvent],
        filesFound: 1,
        skippedRows: 0,
        skippedRowReasons: [],
      },
      {
        source: 'codex',
        events: [codexEvent],
        filesFound: 1,
        skippedRows: 0,
        skippedRowReasons: [],
      },
    ],
    sourceFailures: [],
    filteredEvents: pricedEvents,
    pricingRuntimeConfig: {
      cacheTtlMs: 1_000,
      fetchTimeoutMs: 1_000,
    },
    readEnvVarOverrides: () => [],
  };
}

function createPricingResult(
  pricedEvents: UsageEvent[] = createPricedEvents(),
): UsageEventDatasetPricingResult {
  return {
    pricedEvents,
    pricingOrigin: 'cache',
    pricingWarning: undefined,
  };
}

describe('buildEfficiencyData', () => {
  it('builds efficiency rows and propagates scope diagnostics', async () => {
    const buildUsageEventDatasetMock = vi.fn(async (options: Record<string, unknown>) =>
      createUsageEventDataset(options),
    );
    const applyPricingToUsageEventDatasetMock = vi.fn<
      (...args: unknown[]) => Promise<UsageEventDatasetPricingResult>
    >(async () => createPricingResult());
    const collectGitOutcomesMock = vi.fn(async () => ({
      periodOutcomes: new Map([
        [
          '2026-02-11',
          {
            commitCount: 2,
            linesAdded: 60,
            linesDeleted: 20,
            linesChanged: 80,
          },
        ],
      ]),
      totalOutcomes: {
        commitCount: 2,
        linesAdded: 60,
        linesDeleted: 20,
        linesChanged: 80,
      },
      diagnostics: {
        repoDir: '/tmp/repo',
        includeMergeCommits: false,
        commitsCollected: 2,
        linesAdded: 60,
        linesDeleted: 20,
      },
    }));

    const result = await buildEfficiencyData(
      'daily',
      {
        source: 'pi',
        provider: 'openai',
        model: 'gpt-4.1',
      },
      {
        buildUsageEventDataset: buildUsageEventDatasetMock,
        applyPricingToUsageEventDataset: applyPricingToUsageEventDatasetMock,
        collectGitOutcomes: collectGitOutcomesMock,
        resolveRepoRoot: async (pathHint) => {
          if (pathHint === process.cwd()) {
            return '/tmp/repo';
          }

          if (pathHint === '/workspace/repo-a/app') {
            return '/tmp/repo';
          }

          if (pathHint === '/workspace/repo-b') {
            return '/tmp/other-repo';
          }

          return undefined;
        },
      },
    );

    expect(buildUsageEventDatasetMock.mock.calls[0]?.[0]).toEqual({
      source: 'pi',
      provider: 'openai',
      model: 'gpt-4.1',
    });
    expect(applyPricingToUsageEventDatasetMock.mock.calls[0]?.[2]).toBe('auto');

    expect(collectGitOutcomesMock).toHaveBeenCalledWith({
      repoDir: undefined,
      granularity: 'daily',
      timezone: 'Europe/Paris',
      since: undefined,
      until: undefined,
      includeMergeCommits: undefined,
      activeUsageDays: new Set(['2026-02-11']),
    });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowType: 'period',
      periodKey: '2026-02-11',
      totalTokens: 200,
      commitCount: 2,
      tokensPerCommit: 100,
    });

    expect(result.diagnostics).toMatchObject({
      repoDir: '/tmp/repo',
      includeMergeCommits: false,
      gitCommitCount: 2,
      gitLinesAdded: 60,
      gitLinesDeleted: 20,
      repoMatchedUsageEvents: 1,
      repoExcludedUsageEvents: 1,
      repoUnattributedUsageEvents: 1,
    });
    expect(result.diagnostics.usage).toMatchObject({
      pricingOrigin: 'cache',
      timezone: 'Europe/Paris',
    });
    expect(result.diagnostics.scopeNote).toContain(
      'Usage filters (--source, --provider, --model) affect commit attribution too',
    );
  });

  it('omits scope note when no usage-only filters are active', async () => {
    const result = await buildEfficiencyData(
      'weekly',
      {},
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: async () => ({
          periodOutcomes: new Map(),
          totalOutcomes: {
            commitCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            linesChanged: 0,
          },
          diagnostics: {
            repoDir: '/tmp/repo',
            includeMergeCommits: false,
            commitsCollected: 0,
            linesAdded: 0,
            linesDeleted: 0,
          },
        }),
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    expect(result.diagnostics.scopeNote).toBeUndefined();
    expect(result.diagnostics.repoMatchedUsageEvents).toBe(2);
  });

  it('emits scope note for usage-source overrides beyond source/provider/model filters', async () => {
    const result = await buildEfficiencyData(
      'monthly',
      {
        piDir: '/tmp/pi',
        sourceDir: ['codex=/tmp/codex'],
      },
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: async () => ({
          periodOutcomes: new Map(),
          totalOutcomes: {
            commitCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            linesChanged: 0,
          },
          diagnostics: {
            repoDir: '/tmp/repo',
            includeMergeCommits: false,
            commitsCollected: 0,
            linesAdded: 0,
            linesDeleted: 0,
          },
        }),
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    expect(result.diagnostics.scopeNote).toContain('--pi-dir');
    expect(result.diagnostics.scopeNote).toContain('--source-dir');
  });

  it('includes --gemini-dir and --droid-dir in scope note when configured', async () => {
    const result = await buildEfficiencyData(
      'monthly',
      {
        geminiDir: '/tmp/.gemini',
        droidDir: '/tmp/droid-sessions',
      },
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: async () => ({
          periodOutcomes: new Map(),
          totalOutcomes: {
            commitCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            linesChanged: 0,
          },
          diagnostics: {
            repoDir: '/tmp/repo',
            includeMergeCommits: false,
            commitsCollected: 0,
            linesAdded: 0,
            linesDeleted: 0,
          },
        }),
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    expect(result.diagnostics.scopeNote).toContain('--gemini-dir');
    expect(result.diagnostics.scopeNote).toContain('--droid-dir');
  });

  it('includes --opencode-db in scope note when configured', async () => {
    const result = await buildEfficiencyData(
      'monthly',
      {
        opencodeDb: '/tmp/opencode.db',
      },
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: async () => ({
          periodOutcomes: new Map(),
          totalOutcomes: {
            commitCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            linesChanged: 0,
          },
          diagnostics: {
            repoDir: '/tmp/repo',
            includeMergeCommits: false,
            commitsCollected: 0,
            linesAdded: 0,
            linesDeleted: 0,
          },
        }),
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    expect(result.diagnostics.scopeNote).toContain('--opencode-db');
  });

  it('passes an empty active-usage-day set when no events match the target repo', async () => {
    const collectGitOutcomesMock = vi.fn<CollectGitOutcomesFn>(async () => ({
      periodOutcomes: new Map(),
      totalOutcomes: {
        commitCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesChanged: 0,
      },
      diagnostics: {
        repoDir: '/tmp/repo',
        includeMergeCommits: false,
        commitsCollected: 0,
        linesAdded: 0,
        linesDeleted: 0,
      },
    }));

    await buildEfficiencyData(
      'daily',
      { repoDir: '/tmp/repo' },
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: collectGitOutcomesMock,
        resolveRepoRoot: async () => undefined,
      },
    );

    const options = collectGitOutcomesMock.mock.calls[0]?.[0] as
      | { activeUsageDays?: ReadonlySet<string> }
      | undefined;
    expect(options?.activeUsageDays).toBeDefined();
    expect(options?.activeUsageDays?.size).toBe(0);
  });

  it('ignores matched zero-signal events when deriving active usage days', async () => {
    const collectGitOutcomesMock = vi.fn<CollectGitOutcomesFn>(async () => ({
      periodOutcomes: new Map(),
      totalOutcomes: {
        commitCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesChanged: 0,
      },
      diagnostics: {
        repoDir: '/tmp/repo',
        includeMergeCommits: false,
        commitsCollected: 0,
        linesAdded: 0,
        linesDeleted: 0,
      },
    }));

    await buildEfficiencyData(
      'daily',
      { repoDir: '/tmp/repo' },
      {
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () =>
          createPricingResult([
            {
              source: 'pi',
              sessionId: 'session-zero',
              timestamp: '2026-02-10T10:00:00.000Z',
              repoRoot: '/tmp/repo',
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              costMode: 'explicit',
            },
            {
              source: 'pi',
              sessionId: 'session-signal',
              timestamp: '2026-02-11T10:00:00.000Z',
              repoRoot: '/tmp/repo',
              inputTokens: 20,
              outputTokens: 5,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 25,
              costMode: 'estimated',
            },
          ]),
        collectGitOutcomes: collectGitOutcomesMock,
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    const options = collectGitOutcomesMock.mock.calls[0]?.[0] as
      | { activeUsageDays?: ReadonlySet<string> }
      | undefined;

    expect(options?.activeUsageDays).toEqual(new Set(['2026-02-11']));
  });

  it('rejects blank --repo-dir values before building usage or running git outcomes', async () => {
    const buildUsageEventDatasetMock = vi.fn(async (options: Record<string, unknown>) =>
      createUsageEventDataset(options),
    );
    const collectGitOutcomesMock = vi.fn();

    await expect(
      buildEfficiencyData(
        'daily',
        { repoDir: '   ' },
        {
          buildUsageEventDataset: buildUsageEventDatasetMock,
          collectGitOutcomes: collectGitOutcomesMock,
        },
      ),
    ).rejects.toThrow('--repo-dir must be a non-empty path');

    expect(buildUsageEventDatasetMock).not.toHaveBeenCalled();
    expect(collectGitOutcomesMock).not.toHaveBeenCalled();
  });

  it('captures efficiency-specific runtime stages in usage diagnostics when profiling is enabled', async () => {
    let nowTick = 0;
    const runtimeProfile = new RuntimeProfileCollector(() => {
      nowTick += 1;
      return nowTick;
    });

    const result = await buildEfficiencyData(
      'daily',
      {},
      {
        runtimeProfile,
        buildUsageEventDataset: async (options) => createUsageEventDataset(options),
        applyPricingToUsageEventDataset: async () => createPricingResult(),
        collectGitOutcomes: async () => ({
          periodOutcomes: new Map(),
          totalOutcomes: {
            commitCount: 0,
            linesAdded: 0,
            linesDeleted: 0,
            linesChanged: 0,
          },
          diagnostics: {
            repoDir: '/tmp/repo',
            includeMergeCommits: false,
            commitsCollected: 0,
            linesAdded: 0,
            linesDeleted: 0,
          },
        }),
        resolveRepoRoot: async () => '/tmp/repo',
      },
    );

    expect(
      result.diagnostics.usage.runtimeProfile?.stageTimings.map((timing) => timing.name),
    ).toEqual(
      expect.arrayContaining([
        'efficiency.dataset.total',
        'efficiency.attribute_repo',
        'efficiency.collect_git_outcomes',
        'efficiency.aggregate_usage',
        'efficiency.aggregate',
      ]),
    );
  });
});
