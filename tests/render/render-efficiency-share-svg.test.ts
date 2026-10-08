import { describe, expect, it } from 'vitest';

import type { EfficiencyDataResult } from '../../src/cli/usage-data-contracts.js';
import type { EfficiencyPeriodRow } from '../../src/efficiency/efficiency-row.js';
import { renderEfficiencyMonthlyShareSvg } from '../../src/render/render-efficiency-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import { renderInBothThemes } from './share-svg-assertions.js';

function createData(): EfficiencyDataResult {
  return {
    grouping: 'period',
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
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
      repoDir: '/tmp/repo',
      includeMergeCommits: false,
      gitCommitCount: 6,
      gitMalformedCommitLines: 0,
      gitLinesAdded: 180,
      gitLinesDeleted: 60,
      repoMatchedUsageEvents: 10,
      repoExcludedUsageEvents: 1,
      repoUnattributedUsageEvents: 0,
    },
  };
}

const dark = shareThemes.dark;

function withMonths(count: number): EfficiencyDataResult {
  const data = createData();
  const [template] = data.rows.filter(
    (row): row is EfficiencyPeriodRow => row.rowType === 'period',
  );
  const months = Array.from({ length: count }, (_, index) => ({
    ...template,
    periodKey: `2025-${String(index + 1).padStart(2, '0')}`,
  }));

  return {
    ...data,
    rows: [...months, ...data.rows.filter((row) => row.rowType === 'grand_total')],
  };
}

describe('renderEfficiencyMonthlyShareSvg', () => {
  it('renders spend per commit and commit volume per month in both themes', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderEfficiencyMonthlyShareSvg(createData(), theme),
    );

    expect(svg).toContain('>Efficiency<');
    expect([...svg.matchAll(/data-stat="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'Spend per commit',
      'Commits',
      'Cost',
      'Tokens per commit',
    ]);
    expect(svg).toContain('$2.17');
    expect(svg).toContain('$13.00');
    expect(svg).toContain('>442<');
    expect(svg).toContain('>$2.00<');
    expect(svg).toContain('>$2.50<');
    expect(svg).toContain('<polyline points="');
    expect(svg).toContain('$ llm-usage efficiency monthly --share');
    expect(svg).toContain('2026-01 to 2026-02');
  });

  it('orders months by code point, not locale', () => {
    const data = createData();
    data.rows[0].periodKey = '2026-a';
    data.rows[1].periodKey = '2026-B';

    const svg = renderEfficiencyMonthlyShareSvg(data, dark);

    // Code-point order puts 'B' (U+0042) before 'a' (U+0061); an en locale
    // comparison would flip them.
    expect(svg.indexOf('>2026-B<')).toBeGreaterThan(-1);
    expect(svg.indexOf('>2026-B<')).toBeLessThan(svg.indexOf('>2026-a<'));
  });

  it('keeps the last twelve months and says so', () => {
    const svg = renderEfficiencyMonthlyShareSvg(withMonths(14), dark);

    expect(svg).toContain('(last 12 of 14 months)');
    expect(svg).not.toContain('>2025-02<');
    expect(svg).toContain('>2025-03<');
    expect(svg).toContain('>2025-14<');
  });

  it('draws a single month as a point without a line', () => {
    const svg = renderEfficiencyMonthlyShareSvg(withMonths(1), dark);

    expect(svg).not.toContain('<polyline');
    expect(svg.match(/<circle /gu)).toHaveLength(1);
  });

  it('shows an empty state without months', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderEfficiencyMonthlyShareSvg(withMonths(0), theme),
    );

    expect(svg).toContain('No months with commits and usage');
  });
});
