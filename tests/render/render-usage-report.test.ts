import { describe, expect, it } from 'vitest';

import type { UsageDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderUsageReport } from '../../src/render/render-usage-report.js';

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
        name: 'LLM_USAGE_PARSE_MAX_PARALLEL',
        value: '8',
        description: 'max parallel file parsing',
      },
    ],
    timezone: 'UTC',
  },
};

describe('renderUsageReport', () => {
  it('renders terminal output with header and table only', () => {
    const rendered = renderUsageReport(sampleUsageData, 'terminal', {
      granularity: 'monthly',
      useColor: false,
    });

    expect(rendered).not.toContain('Active environment overrides:');
    expect(rendered).not.toContain('LLM_USAGE_PARSE_MAX_PARALLEL=8');
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
    const rendered = renderUsageReport(sampleUsageData, 'markdown', { granularity: 'daily' });

    expect(rendered).toContain('| Period');
    expect(rendered).toContain('**• gpt-4.1**<br>• gpt-5-codex');
    expect(rendered).not.toContain('tok, $');
    expect(rendered).not.toContain('Σ TOTAL');
  });

  it('renders markdown output with per-model column layout when requested', () => {
    const rendered = renderUsageReport(sampleUsageData, 'markdown', {
      granularity: 'daily',
      tableLayout: 'per_model_columns',
    });

    expect(rendered).toContain('**• gpt-4.1**<br>• gpt-5-codex<br>**Σ TOTAL**');
    expect(rendered).toContain('1,234<br>766<br>2,000');
    expect(rendered).toContain('$1.25<br>$1.50<br>**$2.75**');
  });

  it('renders JSON output as pretty-printed row payload only', () => {
    const rendered = renderUsageReport(sampleUsageData, 'json', { granularity: 'weekly' });

    const parsed = JSON.parse(rendered) as Array<{ rowType: string; periodKey: string }>;

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ rowType: 'period_source', periodKey: '2026-02-10' });
    expect(parsed[2]).toMatchObject({ rowType: 'grand_total', periodKey: 'ALL' });
  });
});
