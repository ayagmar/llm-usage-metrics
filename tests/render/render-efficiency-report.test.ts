import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderEfficiencyReport } from '../../src/render/render-efficiency-report.js';
import type { EfficiencyDataResult } from '../../src/cli/usage-data-contracts.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';

function stripAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

const pendingStdoutRestores = new Set<() => void>();

function overrideStdoutProperty<Key extends 'isTTY' | 'columns'>(
  property: Key,
  value: NodeJS.WriteStream[Key],
): () => void {
  const stdout = process.stdout as NodeJS.WriteStream;
  const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, property);

  Object.defineProperty(stdout, property, {
    configurable: true,
    value,
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(stdout, property, previousDescriptor);
      return;
    }

    Reflect.deleteProperty(stdout, property);
  };
}

function overrideStdoutTty(columns: number): () => void {
  const restoreIsTTY = overrideStdoutProperty('isTTY', true);
  const restoreColumns = overrideStdoutProperty('columns', columns);
  let restored = false;

  const restore = () => {
    if (restored) {
      return;
    }

    restored = true;
    restoreColumns();
    restoreIsTTY();
    pendingStdoutRestores.delete(restore);
  };

  pendingStdoutRestores.add(restore);

  return restore;
}

function createEfficiencyDataResult(
  overrides: Partial<EfficiencyDataResult['diagnostics']['usage']> = {},
): EfficiencyDataResult {
  return {
    grouping: 'period',
    rows: [
      {
        rowType: 'period',
        periodKey: '2026-02-10',
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        commitCount: 1,
        linesAdded: 10,
        linesDeleted: 5,
        linesChanged: 15,
        usdPerCommit: 0,
        usdPer1kLinesChanged: 0,
        tokensPerCommit: 0,
        commitsPerUsd: undefined,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 125,
        costUsd: 2.5,
        costIncomplete: true,
        commitCount: 2,
        linesAdded: 20,
        linesDeleted: 8,
        linesChanged: 28,
        usdPerCommit: 1.25,
        usdPer1kLinesChanged: 89.28571428571429,
        tokensPerCommit: 62.5,
        commitsPerUsd: 0.8,
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
        ...overrides,
      },
      repoDir: '/tmp/repo',
      includeMergeCommits: false,
      gitCommitCount: 2,
      gitMalformedCommitLines: 0,
      gitLinesAdded: 20,
      gitLinesDeleted: 8,
      repoMatchedUsageEvents: 2,
      repoExcludedUsageEvents: 0,
      repoUnattributedUsageEvents: 0,
    },
  };
}

function createBySourceEfficiencyDataResult(): EfficiencyDataResult {
  const data = createEfficiencyDataResult();

  return {
    ...data,
    grouping: 'source',
    rows: [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'codex',
        inputTokens: 60,
        outputTokens: 10,
        reasoningTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 75,
        costUsd: 1.5,
        costShare: 0.6,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 50,
        costUsd: 1,
        costShare: 0.4,
      },
      ...data.rows,
    ],
  };
}

describe('renderEfficiencyReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const restore of pendingStdoutRestores) {
      restore();
    }
    pendingStdoutRestores.clear();
  });

  it('renders markdown output with efficiency columns', () => {
    const output = renderEfficiencyReport(createEfficiencyDataResult(), 'markdown', {
      granularity: 'daily',
    });

    expect(output).toContain('| Period');
    expect(output).toContain('| Commits');
    expect(output).toMatch(/\|\s+\$\/Commit\s+\|/u);
    expect(output).toContain('| Tokens/Commit');
    expect(output).toContain('| 2026-02-10');
    expect(output).toContain('| ALL');
    expect(output).toContain('|         - |');
  });

  it('renders markdown by-source rows with usage cells and undefined outcome cells', () => {
    const output = renderEfficiencyReport(createBySourceEfficiencyDataResult(), 'markdown', {
      granularity: 'daily',
    });

    expect(output).toContain('|   codex');
    expect(output).toMatch(/\|\s+pi\s+\|/u);
    expect(output).toMatch(
      /\|\s+codex\s+\|\s+-\s+\|\s+-\s+\|\s+-\s+\|\s+-\s+\|\s+60\s+\|\s+10\s+\|\s+5\s+\|/u,
    );
    expect(output).toContain('| 2026-02-10');
    expect(output).toContain('| ALL');
  });

  it('escapes markdown and HTML syntax in markdown efficiency cells', () => {
    const data = createEfficiencyDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'period'
        ? {
            ...row,
            periodKey: '[2026-02-10](https://example.test)\n<unsafe>',
          }
        : row,
    );

    const output = renderEfficiencyReport(data, 'markdown', {
      granularity: 'daily',
    });

    expect(output).toContain('\\[2026-02-10\\]\\(https\\://example.test\\)<br>&lt;unsafe&gt;');
    expect(output).not.toContain('[2026-02-10](https://example.test)');
    expect(output).not.toContain('<unsafe>');
  });

  it('renders terminal output with title', () => {
    const output = renderEfficiencyReport(createEfficiencyDataResult(), 'terminal', {
      granularity: 'weekly',
      useColor: false,
    });

    expect(output).toContain('Weekly Efficiency Report');
    expect(output).toContain('│ Period');
    expect(output).toContain('│ ALL');
  });

  it('renders terminal by-source rows under the period subtotal', () => {
    const output = renderEfficiencyReport(createBySourceEfficiencyDataResult(), 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });

    expect(output).toContain('Monthly Efficiency Report');
    expect(output).toContain('│   codex');
    expect(output).toMatch(/│\s+pi\s+│/u);
    expect(output).toMatch(
      /│\s+codex\s+│\s+-\s+│\s+-\s+│\s+-\s+│\s+-\s+│\s+60\s+│\s+10\s+│\s+5\s+│/u,
    );
    expect(output).toContain('│ 2026-02-10');
    expect(output).toContain('│ ALL');
  });

  it('renders colored terminal rows for styled summary metrics', () => {
    const output = renderEfficiencyReport(createEfficiencyDataResult(), 'terminal', {
      granularity: 'daily',
      useColor: true,
    });

    expect(output).toContain('Daily Efficiency Report');
    expect(output).toContain('ALL');
    expect(output).toContain('2026-02-10');
  });

  it('renders exactly 16 colored columns without a phantom Commits/$ column', () => {
    const output = renderEfficiencyReport(createEfficiencyDataResult(), 'terminal', {
      granularity: 'daily',
      useColor: true,
    });
    const stripped = stripAnsi(output);

    // Regression: commitsPerUsd once indexed a 17th column, styling
    // `undefined` green whenever commitsPerUsd > 0.
    expect(stripped).not.toContain('undefined');

    // The one-column title box also uses `│`; table rows carry many more.
    const tableRowLines = stripped.split('\n').filter((line) => line.split('│').length - 1 >= 3);
    expect(tableRowLines.length).toBeGreaterThan(0);

    for (const line of tableRowLines) {
      // 16 columns render as 17 vertical separators.
      expect(line.split('│').length - 1).toBe(17);
    }

    if (pc.isColorSupported) {
      const grandTotalLine = output.split('\n').find((line) => stripAnsi(line).includes('ALL'));

      // The Commits/$ cell (0.80 > 0) is styled green, not a stray column.
      expect(grandTotalLine).toContain(pc.green('~0.80'));
    }
  });

  it('renders monthly terminal title without embedding diagnostics', () => {
    const output = renderEfficiencyReport(
      createEfficiencyDataResult({
        activeEnvOverrides: [
          {
            name: 'LLM_USAGE_PARSE_WORKERS',
            value: '0',
            description: 'parse worker count',
          },
        ],
      }),
      'terminal',
      {
        granularity: 'monthly',
        useColor: false,
      },
    );

    expect(output).not.toContain('Active environment overrides:');
    expect(output).not.toContain('LLM_USAGE_PARSE_WORKERS=0');
    expect(output).toContain('Monthly Efficiency Report');
  });

  it('wraps terminal table columns to fit available tty width', () => {
    const restoreStdout = overrideStdoutTty(120);

    try {
      const output = renderEfficiencyReport(createEfficiencyDataResult(), 'terminal', {
        granularity: 'monthly',
        useColor: false,
      });

      const tableLines = output.split('\n').filter((line) => /[│╭╮╰╯├┼┬┴]/u.test(line));
      const maxWidth = tableLines.reduce(
        (maximumLineWidth, line) => Math.max(maximumLineWidth, visibleWidth(line)),
        0,
      );

      expect(maxWidth).toBeLessThanOrEqual(120);
    } finally {
      restoreStdout();
    }
  });

  it('fits terminal table within a standard 80-column tty', () => {
    const restoreStdout = overrideStdoutTty(80);

    try {
      const output = renderEfficiencyReport(createEfficiencyDataResult(), 'terminal', {
        granularity: 'monthly',
        useColor: false,
      });

      const tableLines = output.split('\n').filter((line) => /[│╭╮╰╯├┼┬┴]/u.test(line));
      const maxWidth = tableLines.reduce(
        (maximumLineWidth, line) => Math.max(maximumLineWidth, visibleWidth(line)),
        0,
      );

      expect(maxWidth).toBeLessThanOrEqual(80);
    } finally {
      restoreStdout();
    }
  });

  it('renders json without undefined derived metrics', () => {
    const output = renderEfficiencyReport(createEfficiencyDataResult(), 'json', {
      granularity: 'monthly',
    });

    const parsed = JSON.parse(output) as Array<Record<string, unknown>>;

    expect(parsed[0]?.commitsPerUsd).toBeUndefined();
    expect(parsed[1]?.tokensPerCommit).toBe(62.5);
  });

  it('renders by-source json with grouping metadata', () => {
    const output = renderEfficiencyReport(createBySourceEfficiencyDataResult(), 'json', {
      granularity: 'monthly',
    });

    const parsed = JSON.parse(output) as {
      grouping?: unknown;
      rows?: Array<Record<string, unknown>>;
    };

    expect(parsed.grouping).toBe('source');
    expect(parsed.rows?.[0]).toMatchObject({
      rowType: 'period_source',
      periodKey: '2026-02-10',
      source: 'codex',
      totalTokens: 75,
      costShare: 0.6,
    });
  });
});
