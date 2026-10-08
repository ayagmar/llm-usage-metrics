import { describe, expect, it } from 'vitest';

import type { UsageDataResult } from '../../src/cli/usage-data-contracts.js';
import {
  describeTableFit,
  renderUsageReportWithNotes,
} from '../../src/render/render-usage-report.js';

const sampleUsageData: UsageDataResult = {
  events: [],
  rows: [
    {
      rowType: 'period_source',
      periodKey: '2026-02-10',
      source: 'pi',
      models: ['gpt-4.1'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          inputTokens: 1234,
          outputTokens: 321,
          reasoningTokens: 0,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
          totalTokens: 1585,
          costUsd: 1.25,
        },
      ],
      inputTokens: 1234,
      outputTokens: 321,
      reasoningTokens: 0,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      totalTokens: 1585,
      costUsd: 1.25,
    },
    {
      rowType: 'period_combined',
      periodKey: '2026-02-10',
      source: 'combined',
      models: ['gpt-4.1', 'gpt-5-codex'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          inputTokens: 1234,
          outputTokens: 321,
          reasoningTokens: 0,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
          totalTokens: 1585,
          costUsd: 1.25,
        },
        {
          model: 'gpt-5-codex',
          inputTokens: 766,
          outputTokens: 179,
          reasoningTokens: 120,
          cacheReadTokens: 70,
          cacheWriteTokens: 0,
          totalTokens: 1135,
          costUsd: 1.5,
        },
      ],
      inputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 120,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      totalTokens: 2720,
      costUsd: 2.75,
    },
    {
      rowType: 'grand_total',
      periodKey: 'ALL',
      source: 'combined',
      models: ['gpt-4.1', 'gpt-5-codex'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          inputTokens: 1234,
          outputTokens: 321,
          reasoningTokens: 0,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
          totalTokens: 1585,
          costUsd: 1.25,
        },
        {
          model: 'gpt-5-codex',
          inputTokens: 766,
          outputTokens: 179,
          reasoningTokens: 120,
          cacheReadTokens: 70,
          cacheWriteTokens: 0,
          totalTokens: 1135,
          costUsd: 1.5,
        },
      ],
      inputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 120,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      totalTokens: 2720,
      costUsd: 2.75,
    },
  ],
  diagnostics: {
    sessionStats: [
      { source: 'pi', filesFound: 1, eventsParsed: 2 },
      { source: 'codex', filesFound: 1, eventsParsed: 2 },
    ],
    sourceFailures: [],
    skippedRows: [],
    pricingOrigin: 'cache',
    activeEnvOverrides: [
      {
        name: 'LLM_USAGE_PARSE_WORKERS',
        value: '0',
        description: 'parse worker count',
      },
    ],
    timezone: 'UTC',
  },
};

describe('renderUsageReportWithNotes output', () => {
  it('renders terminal output with header and table only', () => {
    const rendered = renderUsageReportWithNotes(sampleUsageData, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    }).output;

    expect(rendered).not.toContain('Active environment overrides:');
    expect(rendered).not.toContain('LLM_USAGE_PARSE_WORKERS=0');
    expect(rendered).toContain('Monthly Token Usage Report');
    expect(rendered).not.toContain('Timezone');
    expect(rendered).toContain('│ Period');
    expect(rendered.startsWith('\n')).toBe(false);
    expect(rendered.includes(`${String.fromCharCode(27)}[`)).toBe(false);

    const headerIndex = rendered.indexOf('Monthly Token Usage Report');
    const tableIndex = rendered.indexOf('╭');

    expect(tableIndex).toBeGreaterThan(headerIndex);
  });

  it('renders markdown output in compact mode by default', () => {
    const rendered = renderUsageReportWithNotes(sampleUsageData, 'markdown', {
      granularity: 'daily',
    }).output;

    expect(rendered).toContain('| Period');
    expect(rendered).toContain('**• gpt-4.1**<br>• gpt-5-codex');
    expect(rendered).not.toContain('tok, $');
    expect(rendered).not.toContain('Σ TOTAL');
  });

  it('renders markdown output with per-model column layout when requested', () => {
    const rendered = renderUsageReportWithNotes(sampleUsageData, 'markdown', {
      granularity: 'daily',
      tableLayout: 'per_model_columns',
    }).output;

    expect(rendered).toContain('**• gpt-4.1**<br>• gpt-5-codex<br>**Σ TOTAL**');
    expect(rendered).toContain('1,234<br>766<br>2,000');
    expect(rendered).toContain('$1.25<br>$1.50<br>**$2.75**');
  });

  it('renders an empty-state message instead of an empty table', () => {
    const rendered = renderUsageReportWithNotes({ ...sampleUsageData, rows: [] }, 'terminal', {
      granularity: 'daily',
      useColor: false,
    }).output;

    expect(rendered).toContain('Daily Token Usage Report');
    expect(rendered).toContain('No usage data found for the selected filters.');
    expect(rendered).not.toContain('╭');
    expect(rendered).not.toContain('│ Period');
  });

  it('renders JSON output as pretty-printed row payload only', () => {
    const rendered = renderUsageReportWithNotes(sampleUsageData, 'json', {
      granularity: 'weekly',
    }).output;

    const parsed = JSON.parse(rendered) as {
      schemaVersion: number;
      report: string;
      data: Array<{ rowType: string; periodKey: string }>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'usage' });
    expect(parsed.data).toHaveLength(3);
    expect(parsed.data[0]).toMatchObject({ rowType: 'period_source', periodKey: '2026-02-10' });
    expect(parsed.data[2]).toMatchObject({ rowType: 'grand_total', periodKey: 'ALL' });
  });

  it('notes what a narrow terminal left out of the table', () => {
    const { output, notes } = renderUsageReportWithNotes(sampleUsageData, 'terminal', {
      granularity: 'daily',
      useColor: false,
      terminalWidth: 75,
    });

    expect(output).not.toContain('Reasoning');
    expect(notes).toEqual([
      'Fitted the table to the terminal: abbreviated token counts, hid Reasoning, Cache Write and Models. Widen the terminal or use --json for full detail.',
    ]);
  });

  it('adds no note when the full table fits or the output is not a terminal table', () => {
    const wide = renderUsageReportWithNotes(sampleUsageData, 'terminal', {
      granularity: 'daily',
      useColor: false,
      terminalWidth: 200,
    });
    const markdown = renderUsageReportWithNotes(sampleUsageData, 'markdown', {
      granularity: 'daily',
      compact: true,
    });
    const empty = renderUsageReportWithNotes({ ...sampleUsageData, rows: [] }, 'terminal', {
      granularity: 'daily',
      useColor: false,
      terminalWidth: 40,
    });

    expect([wide.notes, markdown.notes, empty.notes]).toEqual([[], [], []]);
    expect(markdown.output).not.toContain('Reasoning');
  });

  it('leaves out of the note what --compact already asked for', () => {
    const fit = {
      tokenFormat: 'abbreviated' as const,
      hiddenColumns: ['reasoning' as const, 'cacheWrite' as const],
      truncatedModelNames: false,
    };

    expect(describeTableFit(fit, true)).toBeUndefined();
    expect(describeTableFit({ ...fit, truncatedModelNames: true }, true)).toBe(
      'Fitted the table to the terminal: shortened model names. Widen the terminal or use --json for full detail.',
    );
    expect(
      describeTableFit({ ...fit, hiddenColumns: [...fit.hiddenColumns, 'models'] }, true),
    ).toBe(
      'Fitted the table to the terminal: hid Models. Widen the terminal or use --json for full detail.',
    );
    expect(describeTableFit(fit, false)).toContain('hid Reasoning and Cache Write');
  });
});
