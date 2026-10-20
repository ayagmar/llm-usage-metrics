import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { describe, expect, it } from 'vitest';

import type { OptimizeDataResult } from '../../src/cli/usage-data-contracts.js';
import {
  renderOptimizeReport,
  renderOptimizeReportWithNotes,
} from '../../src/render/render-optimize-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

function stripAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

function renderTerminalAtWidth(
  data: OptimizeDataResult,
  columns: number,
  useColor = false,
): string {
  const restoreStdout = overrideStdoutTty(columns);

  try {
    return renderOptimizeReport(data, 'terminal', { granularity: 'daily', useColor });
  } finally {
    restoreStdout();
  }
}

function withoutNotes(data: OptimizeDataResult): OptimizeDataResult {
  return {
    ...data,
    rows: data.rows.map((row) =>
      row.rowType === 'candidate' ? { ...row, notes: undefined } : row,
    ),
  };
}

function maxLineWidth(output: string): number {
  return Math.max(...output.split('\n').map((line) => visibleWidth(line)));
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
        savingsRatio: 0.12,
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
        savingsRatio: 0.12,
      },
    ],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'cache',
      activeEnvOverrides: [],
      timezone: 'UTC',
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
    expect(output).toContain('ALL best candidate: gpt-4.1 saves $0.15 (12.0%)');
    expect(output).toContain(
      'Savings = Baseline - Hypothetical (positive means cheaper candidate)',
    );
    expect(output).toContain('│ Period');
    expect(output).toContain('│ Candidate');
    expect(output).toContain('│ Hypothetical Cost');
  });

  it('prints the provider and the no-usage message when the baseline has no usage', () => {
    const data = createOptimizeDataResult();
    // As an empty window builds it: zero tokens and a complete $0 baseline.
    data.rows = data.rows.map((row) =>
      row.rowType === 'baseline'
        ? { ...row, totalTokens: 0, baselineCostUsd: 0 }
        : { ...row, totalTokens: 0 },
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'monthly',
      useColor: false,
      filtered: true,
    });

    expect(output).not.toContain('╭');
    expect(output).not.toContain('ALL baseline cost');
    expect(output.split('\n').slice(-3)).toEqual([
      'Provider scope: openai',
      '',
      'No usage data found for the selected filters.',
    ]);
  });

  it('shows logged spend from events without token counts instead of the no-usage message', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) => ({
      ...row,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ...(row.rowType === 'baseline' ? { baselineCostUsd: 10 } : {}),
    }));

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });

    expect(output).not.toContain('No usage data found');
    expect(output).toContain('ALL baseline cost: $10.00');
    expect(output).toContain('╭');
  });

  it('shows a baseline whose cost is incomplete even with no tokens or priced cost', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'baseline'
        ? { ...row, totalTokens: 0, baselineCostUsd: undefined, baselineCostIncomplete: true }
        : { ...row, totalTokens: 0 },
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });

    expect(output).not.toContain('No usage data found');
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
            savingsRatio: undefined,
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
            savingsRatio: -0.2,
          }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: false,
    });

    expect(output).toContain('ALL best candidate: gpt-4.1 increases cost by $0.25 (-20.0%)');
  });

  it('reports ALL candidate cost matches when savings are neutral', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey === 'ALL'
        ? {
            ...row,
            savingsUsd: 0,
            savingsRatio: 0,
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

  it('keeps every column when the table fits the terminal', () => {
    const output = renderTerminalAtWidth(createOptimizeDataResult(), 120);

    expect(output).toContain('│ Hypothetical Cost');
    expect(output).toContain('│ Notes');
    expect(output).toContain('│     12.0% │');
    expect(maxLineWidth(output)).toBeLessThanOrEqual(120);
  });

  it('leaves out Hypothetical Cost to fit an 80-column terminal', () => {
    for (const useColor of [false, true]) {
      const output = renderTerminalAtWidth(withoutNotes(createOptimizeDataResult()), 80, useColor);
      const lines = output.split('\n');
      const tableLines = lines.slice(lines.findIndex((line) => stripAnsi(line).startsWith('╭')));
      const boxWidths = new Set(tableLines.map((line) => visibleWidth(line)));

      expect(stripAnsi(output)).toContain('╭');
      expect(output).not.toContain('Hypothetical Cost');
      expect(stripAnsi(output)).toContain('│ Baseline Cost');
      expect(stripAnsi(output)).toContain('│ Savings %');
      expect(maxLineWidth(output)).toBeLessThanOrEqual(80);
      expect(boxWidths.size).toBe(1);
    }
  });

  it('lists rows rather than leave out the notes', () => {
    const output = renderTerminalAtWidth(createOptimizeDataResult(), 80);

    expect(output).not.toContain('╭');
    expect(output).toContain('Notes              baseline_incomplete');
    expect(maxLineWidth(output)).toBeLessThanOrEqual(80);
  });

  it.each([34, 44])(
    'breaks a listed note code between its words at %i columns',
    (terminalWidth) => {
      const data = createOptimizeDataResult();
      data.rows = data.rows.map((row) =>
        row.rowType === 'candidate' && row.notes
          ? { ...row, notes: ['cache_write_priced_as_input'] }
          : row,
      );

      const output = renderTerminalAtWidth(data, terminalWidth);
      const lines = output.split('\n');
      const noteStart = lines.findIndex((line) => /^ {2}Notes +cache_/u.test(line));
      const noteLines = lines
        .slice(
          noteStart,
          lines.findIndex((line, index) => index > noteStart && !/^ {3,}\S/u.test(line)),
        )
        .map((line) => line.replace(/^ {2}Notes/u, '').trim());

      expect(maxLineWidth(output)).toBeLessThanOrEqual(terminalWidth);
      expect(noteLines.join('')).toBe('cache_write_priced_as_input');
      expect(noteLines.slice(0, -1).every((line) => line.endsWith('_'))).toBe(true);
    },
  );

  it('wraps notes on a terminal but keeps them on one line when piped', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.notes
        ? { ...row, notes: ['baseline_incomplete', 'cache_write_priced_as_input'] }
        : row,
    );

    expect(renderTerminalAtWidth(data, 160)).toContain('│ baseline_incomplete,        │');
    expect(
      renderOptimizeReport(data, 'terminal', { granularity: 'daily', useColor: false }),
    ).toContain('│ baseline_incomplete, cache_write_priced_as_input │');
  });

  it('keeps Hypothetical Cost when an incomplete baseline leaves out the savings', () => {
    const data = withoutNotes(createOptimizeDataResult());
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey !== 'ALL'
        ? { ...row, savingsUsd: undefined, savingsRatio: undefined }
        : row,
    );

    const output = renderTerminalAtWidth(data, 90);

    expect(output).toContain('│ Hypothetical Cost');
    expect(output).toContain('│ gpt-4.1   │             $1.10 │');
  });

  it('keeps Hypothetical Cost when Baseline Cost minus Savings is a cent off after rounding', () => {
    const data = withoutNotes(createOptimizeDataResult());
    data.rows = data.rows.map((row) => {
      if (row.periodKey !== 'ALL') {
        return row;
      }

      return row.rowType === 'baseline'
        ? { ...row, baselineCostUsd: 1.004 }
        : { ...row, hypotheticalCostUsd: 0.005, savingsUsd: 0.999, savingsRatio: 0.995 };
    });

    const output = renderTerminalAtWidth(data, 90);

    expect(output).toContain('│ Hypothetical Cost');
    expect(output).toContain('$0.01');
  });

  it('prints a cost increase that rounds to zero percent without a sign', () => {
    const data = withoutNotes(createOptimizeDataResult());
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate'
        ? { ...row, hypotheticalCostUsd: 1.25005, savingsUsd: -0.00005, savingsRatio: -0.00004 }
        : row,
    );

    const output = renderTerminalAtWidth(data, 120);

    expect(output).not.toContain('-0.0%');
    expect(output).toContain('(0.0%)');
    expect(output).toContain('│      0.0% │');
  });

  it('lists rows and wraps the context lines on a 44-column terminal', () => {
    const output = renderTerminalAtWidth(createOptimizeDataResult(), 44);

    expect(output).not.toContain('╭');
    expect(output).toContain('2026-02-10 · gpt-4.1');
    expect(output).toContain('Hypothetical Cost');
    expect(output).toContain(
      'Savings = Baseline - Hypothetical (positive\nmeans cheaper candidate)',
    );
    expect(maxLineWidth(output)).toBeLessThanOrEqual(44);
  });

  it('colors costs as money and savings by direction', () => {
    const data = createOptimizeDataResult();
    data.rows = data.rows.map((row) =>
      row.rowType === 'candidate' && row.periodKey !== 'ALL'
        ? { ...row, hypotheticalCostUsd: 1.5, savingsUsd: -0.25, savingsRatio: -0.2 }
        : row,
    );

    const output = renderOptimizeReport(data, 'terminal', {
      granularity: 'daily',
      useColor: true,
    });

    expect(output).toContain(pc.yellow('$1.50'));
    expect(output).toContain(pc.red('-$0.25'));
    expect(output).toContain(pc.red('-20.0%'));
    expect(output).toContain(pc.green('$0.15'));
    expect(output).toContain(pc.bold(pc.yellow('$1.10')));
  });

  it('names the provider scope above the markdown table', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'markdown', {
      granularity: 'daily',
    });

    expect(output.split('\n').slice(0, 3)).toEqual([
      'Provider scope: openai',
      '',
      expect.stringMatching(/^\| Period/u),
    ]);
    expect(output).toContain('12.0%');
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

    expect(output).toContain('\\[gpt-4.1\\]\\(https\\://example.test\\)');
    expect(output).toContain('\\*note\\*, &lt;unsafe&gt;');
    expect(output).not.toContain('[gpt-4.1](https://example.test)');
    expect(output).not.toContain('<unsafe>');
  });

  it('renders JSON output as rows only', () => {
    const output = renderOptimizeReport(createOptimizeDataResult(), 'json', {
      granularity: 'monthly',
    });

    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      report: string;
      data: Array<{ rowType: string; periodKey: string }>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'optimize' });
    expect(parsed.data).toHaveLength(4);
    expect(parsed.data[0]).toMatchObject({ rowType: 'baseline', periodKey: '2026-02-10' });
    expect(parsed.data[3]).toMatchObject({ rowType: 'candidate', periodKey: 'ALL' });
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
    expect(strippedOutput).toContain('ALL best candidate: gpt-4.1 saves $0.15 (12.0%)');
  });
});

describe('renderOptimizeReportWithNotes', () => {
  const notesAt = (data: OptimizeDataResult, columns: number) => {
    const restoreStdout = overrideStdoutTty(columns);

    try {
      return renderOptimizeReportWithNotes(data, 'terminal', {
        granularity: 'daily',
        useColor: false,
      });
    } finally {
      restoreStdout();
    }
  };

  it('names the column it left out at 80 columns, outside stdout', () => {
    const { output, notes } = notesAt(withoutNotes(createOptimizeDataResult()), 80);

    expect(notes).toEqual([
      'Fitted the table to the terminal: hid Hypothetical Cost. Widen the terminal or use --json for full detail.',
    ]);
    expect(output).not.toContain('Hypothetical Cost');
    expect(output).not.toContain(notes[0]);
  });

  it('says rows were listed at 44 columns', () => {
    const { output, notes } = notesAt(createOptimizeDataResult(), 44);

    expect(notes).toEqual([
      'Listed rows instead of a table to fit the terminal. Widen the terminal to see the table.',
    ]);
    expect(output).not.toContain('╭');
    expect(output).not.toContain(notes[0]);
  });

  it('has no note when the table fits, or for markdown and json', () => {
    expect(notesAt(createOptimizeDataResult(), 400).notes).toEqual([]);

    const restoreStdout = overrideStdoutTty(44);

    try {
      for (const format of ['markdown', 'json'] as const) {
        const options = { granularity: 'daily', useColor: false } as const;

        expect(
          renderOptimizeReportWithNotes(createOptimizeDataResult(), format, options).notes,
        ).toEqual([]);
      }
    } finally {
      restoreStdout();
    }
  });
});
