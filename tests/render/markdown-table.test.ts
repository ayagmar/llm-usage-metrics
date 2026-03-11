import { describe, expect, it } from 'vitest';

import type { UsageReportRow } from '../../src/domain/usage-report-row.js';
import { renderMarkdownTable } from '../../src/render/markdown-table.js';

const sampleRows: UsageReportRow[] = [
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
];

describe('renderMarkdownTable', () => {
  it('renders compact model names by default', () => {
    const rendered = renderMarkdownTable(sampleRows);

    expect(rendered).toMatchInlineSnapshot(`
      "| Period     | Source       | Models                         | Input | Output | Reasoning | Cache Read | Cache Write |     Total |      Cost |
      | :--------- | :----------- | :----------------------------- | ----: | -----: | --------: | ---------: | ----------: | --------: | --------: |
      | 2026-02-10 | pi           | • gpt-4.1                      | 1,234 |    321 |         0 |         30 |           0 |     1,585 |     $1.25 |
      | 2026-02-10 | **combined** | **• gpt-4.1**<br>• gpt-5-codex | 2,000 |    500 |       120 |        100 |           0 | **2,720** | **$2.75** |
      | **ALL**    | **TOTAL**    | **• gpt-4.1**<br>• gpt-5-codex | 2,000 |    500 |       120 |        100 |           0 | **2,720** | **$2.75** |"
    `);
    expect(rendered).toContain('<br>');
    expect(rendered).not.toContain('tok, $');
  });

  it('renders per-model aligned columns when enabled', () => {
    const rendered = renderMarkdownTable(sampleRows, { tableLayout: 'per_model_columns' });

    expect(rendered).toMatchInlineSnapshot(`
      "| Period     | Source       | Models                                        |                 Input |            Output |       Reasoning |      Cache Read | Cache Write |                       Total |                        Cost |
      | :--------- | :----------- | :-------------------------------------------- | --------------------: | ----------------: | --------------: | --------------: | ----------: | --------------------------: | --------------------------: |
      | 2026-02-10 | pi           | • gpt-4.1                                     |                 1,234 |               321 |               0 |              30 |           0 |                       1,585 |                       $1.25 |
      | 2026-02-10 | **combined** | **• gpt-4.1**<br>• gpt-5-codex<br>**Σ TOTAL** | 1,234<br>766<br>2,000 | 321<br>179<br>500 | 0<br>120<br>120 | 30<br>70<br>100 | 0<br>0<br>0 | 1,585<br>1,135<br>**2,720** | $1.25<br>$1.50<br>**$2.75** |
      | **ALL**    | **TOTAL**    | **• gpt-4.1**<br>• gpt-5-codex<br>**Σ TOTAL** | 1,234<br>766<br>2,000 | 321<br>179<br>500 | 0<br>120<br>120 | 30<br>70<br>100 | 0<br>0<br>0 | 1,585<br>1,135<br>**2,720** | $1.25<br>$1.50<br>**$2.75** |"
    `);
    expect(rendered).toContain('**Σ TOTAL**');
    expect(rendered).toContain('1,234<br>766<br>2,000');
    expect(rendered).toContain('$1.25<br>$1.50<br>**$2.75**');
  });

  it('normalizes CRLF newlines in cell values', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [
          {
            model: 'gpt-4.1\r\ngpt-4.1-mini',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [
          {
            model: 'gpt-4.1\r\ngpt-4.1-mini',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
    ]);

    expect(rendered).toContain('<br>');
    expect(rendered).not.toContain('\r');
  });

  it('renders unknown cost values as "-" instead of NaN', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: undefined,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: undefined,
      },
    ]);

    expect(rendered).toContain('2026-02-10');
    expect(rendered).toContain('• gpt-4.1');
    expect(rendered).toMatch(/\|\s+-\s+\|/u);
    expect(rendered).not.toContain('NaN');
  });

  it('escapes pipe characters in markdown cell content', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt|4.1'],
        modelBreakdown: [
          {
            model: 'gpt|4.1',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
    ]);

    expect(rendered).toContain('gpt\\|4.1');
  });

  it('escapes HTML-like cell content instead of rendering it as raw markup', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['<gpt>&4.1'],
        modelBreakdown: [
          {
            model: '<gpt>&4.1',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
    ]);

    expect(rendered).toContain('&lt;gpt&gt;&amp;4.1');
    expect(rendered).not.toContain('<gpt>&4.1');
  });

  it('escapes inline markdown control characters before applying emphasis', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_combined',
        periodKey: '2026-02-10',
        source: 'combined',
        models: ['[gpt-4.1](https://example.test)', 'gpt-5-codex'],
        modelBreakdown: [
          {
            model: '[gpt-4.1](https://example.test)',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
          {
            model: 'gpt-5-codex',
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
    ]);

    expect(rendered).toContain('**• \\[gpt-4.1\\]\\(https\\://example.test\\)**');
    expect(rendered).not.toContain('[gpt-4.1](https://example.test)');
  });

  it('preserves blank model lines while escaping multiline emphasized markdown cells', () => {
    const rendered = renderMarkdownTable([
      {
        rowType: 'period_combined',
        periodKey: '2026-02-10',
        source: 'combined',
        models: ['gpt-4.1', 'gpt-5-codex'],
        modelBreakdown: [
          {
            model: 'gpt-4.1\n\n[gpt-4.1-mini](https://example.test)',
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.02,
          },
          {
            model: 'gpt-5-codex',
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        ],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.02,
      },
    ]);

    expect(rendered).toContain(
      '**• gpt-4.1**<br><br>\\[gpt-4.1-mini\\]\\(https\\://example.test\\)<br>• gpt-5-codex',
    );
  });
});
