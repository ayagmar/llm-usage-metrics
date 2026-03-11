import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { describe, expect, it } from 'vitest';

import type { OptimizeDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderOptimizeReport } from '../../src/render/render-optimize-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';

function stripAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

function createOptimizeDataResult(): OptimizeDataResult {
  return {
    rows: [
      {
        rowType: 'baseline',
        periodKey: '2026-02-10',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        baselineCostUsd: 1.25,
        baselineCostIncomplete: false,
      },
      {
        rowType: 'candidate',
        periodKey: '2026-02-10',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4.1',
        candidateResolvedModel: 'gpt-4.1',
        hypotheticalCostUsd: 1.1,
        hypotheticalCostIncomplete: false,
        savingsUsd: 0.15,
        savingsPct: 0.12,
        notes: ['baseline_incomplete'],
      },
      {
        rowType: 'baseline',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        baselineCostUsd: 1.25,
        baselineCostIncomplete: false,
      },
      {
        rowType: 'candidate',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4.1',
        candidateResolvedModel: 'gpt-4.1',
        hypotheticalCostUsd: 1.1,
        hypotheticalCostIncomplete: false,
        savingsUsd: 0.15,
        savingsPct: 0.12,
      },
    ],
    diagnostics: {
      usage: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'cache',
        activeEnvOverrides: [],
        timezone: 'UTC',
      },
      provider: 'openai',
      baselineCostIncomplete: false,
      candidatesWithMissingPricing: [],
    },
  };
}

describe('renderOptimizeReport', () => {
  it('renders terminal output with title and optimize columns', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'terminal', {
      granularity: 'weekly',
      useColor: false,
    });

    expect(output).toContain('Weekly Optimize Report');
    expect(output).toContain('Provider scope: openai');
    expect(output).toContain('ALL baseline cost: $1.25');
    expect(output).toContain('ALL best candidate: gpt-4.1 saves $0.15 (12.00%)');
    expect(output).toContain(
      'Savings = Baseline - Hypothetical (positive means cheaper candidate)',
    );
    expect(output).toContain('│ Period');
    expect(output).toContain('│ Candidate');
    expect(output).toContain('│ Hypothetical Cost');
  });

  it('renders missing-pricing context in terminal output', () => {
    const data = createOptimizeDataResult();
    data.diagnostics.candidatesWithMissingPricing = ['gpt-4.1-mini'];

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });

    expect(output).toContain('Missing candidate pricing: gpt-4.1-mini');
  });

  it('reports unavailable ALL candidate summaries when savings cannot be computed', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey === 'ALL'
        ? {
            ...row,
            savingsUsd: undefined,
            savingsPct: undefined,
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    expect(output).toContain(
      'ALL best candidate: unavailable (missing baseline or candidate pricing)',
    );
  });

  it('reports ALL candidate cost increases when the best candidate is more expensive', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey === 'ALL'
        ? {
            ...row,
            savingsUsd: -0.25,
            savingsPct: -0.2,
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    expect(output).toContain('ALL best candidate: gpt-4.1 increases cost by $0.25 (-20.00%)');
  });

  it('reports ALL candidate cost matches when savings are neutral', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey === 'ALL'
        ? {
            ...row,
            savingsUsd: 0,
            savingsPct: 0,
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    expect(output).toContain('ALL best candidate: gpt-4.1 matches baseline cost');
  });

  it('hides notes column when no candidate notes are present', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate'
        ? {
            ...row,
            notes: undefined,
          }
        : row,
    );

    const terminalOutput = renderOptimizeReport(data, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });
    const markdownOutput = renderOptimizeReport(data, 'markdown', {
      granularity: 'monthly',
    });

    expect(terminalOutput).not.toContain('│ Notes');
    expect(markdownOutput).not.toContain('| Notes');
  });

  it('keeps terminal table borders aligned with long candidate names', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate'
        ? {
            ...row,
            candidateModel: 'a-very-long-candidate-model-name',
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    const firstTableLineIndex = output.split('\n').findIndex((line) => line.startsWith('╭'));
    const tableSection =
      firstTableLineIndex >= 0 ? output.split('\n').slice(firstTableLineIndex) : [];
    const tableLines = tableSection.filter((line) => /[│╭╮╰╯├┼┬┴]/u.test(line));
    const renderedWidths = [...new Set(tableLines.map((line) => visibleWidth(line)))];

    expect(renderedWidths).toHaveLength(1);
  });

  it('top-aligns period cells with multiline candidate rows in compact terminal output', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate'
        ? {
            ...row,
            candidateModel: 'gpt-4.1\ngpt-4.1-mini',
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    expect(output).toContain('│ 2026-02-10 │ gpt-4.1');
    expect(output).toContain('│ ALL        │ gpt-4.1');
    expect(output.match(/│\s+│ gpt-4\.1-mini/gu)).toHaveLength(2);
  });

  it('renders markdown output with candidate column', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'markdown', {
      granularity: 'daily',
    });

    expect(output).toContain('| Candidate');
    expect(output).toContain('| BASELINE');
    expect(output).toContain('| gpt-4.1');
  });

  it('escapes markdown and HTML syntax in markdown optimize cells', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate'
        ? {
            ...row,
            candidateModel: '[gpt-4.1](https://example.test)',
            notes: ['*note*', '<unsafe>'],
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'markdown', {
      granularity: 'daily',
    });

    expect(output).toContain('\\[gpt-4.1\\]\\(https://example.test\\)');
    expect(output).toContain('\\*note\\*, &lt;unsafe&gt;');
    expect(output).not.toContain('[gpt-4.1](https://example.test)');
    expect(output).not.toContain('<unsafe>');
  });

  it('renders JSON output as rows only', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'json', {
      granularity: 'monthly',
    });

    const parsed = JSON.parse(output) as Array<{ rowType: string; periodKey: string }>;

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ rowType: 'baseline', periodKey: '2026-02-10' });
    expect(parsed[3]).toMatchObject({ rowType: 'candidate', periodKey: 'ALL' });
  });

  it('renders colored terminal output without changing visible optimize context', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'terminal', {
      granularity: 'monthly',
      useColor: true,
    });
    const strippedOutput = stripAnsi(output);

    if (pc.isColorSupported) {
      expect(output).not.toBe(strippedOutput);
    }
    expect(strippedOutput).toContain('Monthly Optimize Report');
    expect(strippedOutput).toContain('Provider scope: openai');
    expect(strippedOutput).toContain('ALL best candidate: gpt-4.1 saves $0.15 (12.00%)');
  });
});
