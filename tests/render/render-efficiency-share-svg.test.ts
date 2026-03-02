import { describe, expect, it } from 'vitest';

import type { EfficiencyDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderEfficiencyMonthlyShareSvg } from '../../src/render/render-efficiency-share-svg.js';

function createData(): EfficiencyDataResult {
  return {
    rows: [
      {
        rowType: 'period',
        periodKey: '2026-01',
        commitCount: 4,
        linesAdded: 120,
        linesDeleted: 40,
        linesChanged: 160,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        totalTokens: 1800,
        costUsd: 8,
        usdPerCommit: 2,
        usdPer1kLinesChanged: 50,
        tokensPerCommit: 400,
        commitsPerUsd: 0.5,
      },
      {
        rowType: 'period',
        periodKey: '2026-02',
        commitCount: 2,
        linesAdded: 60,
        linesDeleted: 20,
        linesChanged: 80,
        inputTokens: 700,
        outputTokens: 300,
        reasoningTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 1150,
        costUsd: 5,
        usdPerCommit: 2.5,
        usdPer1kLinesChanged: 62.5,
        tokensPerCommit: 525,
        commitsPerUsd: 0.4,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        commitCount: 6,
        linesAdded: 180,
        linesDeleted: 60,
        linesChanged: 240,
        inputTokens: 1700,
        outputTokens: 800,
        reasoningTokens: 150,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        totalTokens: 2950,
        costUsd: 13,
        usdPerCommit: 2.1667,
        usdPer1kLinesChanged: 54.1667,
        tokensPerCommit: 441.67,
        commitsPerUsd: 0.46,
      },
    ],
    diagnostics: {
      usage: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
      },
      repoDir: '/tmp/repo',
      includeMergeCommits: false,
      gitCommitCount: 6,
      gitLinesAdded: 180,
      gitLinesDeleted: 60,
      repoMatchedUsageEvents: 10,
      repoExcludedUsageEvents: 1,
      repoUnattributedUsageEvents: 0,
    },
  };
}

describe('renderEfficiencyMonthlyShareSvg', () => {
  it('renders a monthly efficiency SVG with period labels and summary metrics', () => {
    const svg = renderEfficiencyMonthlyShareSvg(createData());

    expect(svg).toContain('<svg');
    expect(svg).toContain('Monthly Efficiency');
    expect(svg).toContain('2026-01');
    expect(svg).toContain('2026-02');
    expect(svg).toContain('Total Cost');
    expect(svg).toContain('$13.00');
  });
});
