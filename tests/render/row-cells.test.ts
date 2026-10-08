import { describe, expect, it } from 'vitest';

import type { UsageReportRow } from '../../src/domain/usage-report-row.js';
import {
  getUsageTableHeader,
  getVisibleUsageColumnIndexes,
  selectColumns,
  toUsageTableCells,
  usageTableHeaders,
} from '../../src/render/row-cells.js';

describe('row-cells', () => {
  it('renders compact layout fallbacks and grand-total source label', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: undefined,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 1500,
        outputTokens: 500,
        reasoningTokens: 0,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
        totalTokens: 2035,
        costUsd: undefined,
      },
    ];

    expect(usageTableHeaders).toEqual([
      'Period',
      'Source',
      'Models',
      'Input',
      'Output',
      'Reasoning',
      'Cache Read',
      'Cache Write',
      'Total',
      'Cost',
    ]);

    const cells = toUsageTableCells(rows);

    expect(cells[0]).toEqual(['2026-02-10', 'pi', '-', '0', '0', '0', '0', '0', '0', '-']);
    expect(toUsageTableCells([{ ...rows[0], machine: 'laptop' } as UsageReportRow])[0][1]).toBe(
      'pi (laptop)',
    );
    expect(cells[1]).toEqual([
      'ALL',
      'TOTAL',
      '• gpt-4.1',
      '1,500',
      '500',
      '0',
      '25',
      '10',
      '2,035',
      '-',
    ]);
  });

  it('renders per-model columns with Σ TOTAL and aggregated metric lines', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_combined',
        periodKey: '2026-02-10',
        source: 'combined',
        models: ['gpt-4.1', 'gpt-5'],
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
            model: 'gpt-5',
            inputTokens: 766,
            outputTokens: 179,
            reasoningTokens: 120,
            cacheReadTokens: 70,
            cacheWriteTokens: 0,
            totalTokens: 1135,
            costUsd: undefined,
          },
        ],
        inputTokens: 2000,
        outputTokens: 500,
        reasoningTokens: 120,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 2720,
        costUsd: undefined,
      },
    ];

    const cells = toUsageTableCells(rows, { layout: 'per_model_columns' });

    expect(cells[0]?.[2]).toBe('• gpt-4.1\n• gpt-5\nΣ TOTAL');
    expect(cells[0]?.[3]).toBe('1,234\n766\n2,000');
    expect(cells[0]?.[4]).toBe('321\n179\n500');
    expect(cells[0]?.[5]).toBe('0\n120\n120');
    expect(cells[0]?.[9]).toBe('$1.25\n-\n-');
  });

  it('does not append Σ TOTAL in per-model layout when only one model is present', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [
          {
            model: 'gpt-4.1',
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 150,
            costUsd: 0.25,
          },
        ],
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 0.25,
      },
    ];

    const cells = toUsageTableCells(rows, { layout: 'per_model_columns' });

    expect(cells[0]?.[2]).toBe('• gpt-4.1');
    expect(cells[0]?.[3]).toBe('100');
    expect(cells[0]?.[9]).toBe('$0.25');
  });

  it('signals incomplete pricing with prefixed cost values while preserving known totals', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_combined',
        periodKey: '2026-02-10',
        source: 'combined',
        models: ['gpt-4.1', 'gpt-5'],
        modelBreakdown: [
          {
            model: 'gpt-4.1',
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 150,
            costUsd: 1.25,
            costIncomplete: true,
          },
          {
            model: 'gpt-5',
            inputTokens: 50,
            outputTokens: 25,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 75,
            costUsd: 0,
            costIncomplete: true,
          },
        ],
        inputTokens: 150,
        outputTokens: 75,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 225,
        costUsd: 1.25,
        costIncomplete: true,
      },
    ];

    const compactCells = toUsageTableCells(rows);
    expect(compactCells[0]?.[9]).toBe('~$1.25');

    const perModelCells = toUsageTableCells(rows, { layout: 'per_model_columns' });
    expect(perModelCells[0]?.[9]).toBe('~$1.25\n~$0.00\n~$1.25');
  });

  it('renders unknown-only incomplete costs as dash instead of ~ $0.00', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [
          {
            model: 'gpt-4.1',
            inputTokens: 10,
            outputTokens: 10,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 20,
            costUsd: undefined,
            costIncomplete: true,
          },
        ],
        inputTokens: 10,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 20,
        costUsd: undefined,
        costIncomplete: true,
      },
    ];

    const compactCells = toUsageTableCells(rows);
    expect(compactCells[0]?.[9]).toBe('-');

    const perModelCells = toUsageTableCells(rows, { layout: 'per_model_columns' });
    expect(perModelCells[0]?.[9]).toBe('-');
  });

  it('abbreviates token counts but keeps cost exact', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 999,
        outputTokens: 24_296,
        reasoningTokens: 999_999,
        cacheReadTokens: 615_776_407,
        cacheWriteTokens: 0,
        totalTokens: 1_810_162_608,
        costUsd: 1234.5,
      },
    ];

    expect(toUsageTableCells(rows, { tokenFormat: 'abbreviated' })[0].slice(3)).toEqual([
      '999',
      '24.3K',
      '1M',
      '616M',
      '0',
      '1.81B',
      '$1,234.50',
    ]);
  });

  it('selects visible columns in table order', () => {
    const columns = getVisibleUsageColumnIndexes(new Set(['models', 'reasoning']));

    expect(selectColumns(usageTableHeaders, columns)).toEqual([
      'Period',
      'Source',
      'Input',
      'Output',
      'Cache Read',
      'Cache Write',
      'Total',
      'Cost',
    ]);
    expect(getUsageTableHeader('cacheWrite')).toBe('Cache Write');
  });
});
