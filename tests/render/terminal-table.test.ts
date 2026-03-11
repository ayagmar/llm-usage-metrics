import { afterEach, describe, expect, it } from 'vitest';

import type { UsageReportRow } from '../../src/domain/usage-report-row.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import { renderTerminalTable, shouldUseColorByDefault } from '../../src/render/terminal-table.js';

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

const originalNoColor = process.env.NO_COLOR;
const originalForceColor = process.env.FORCE_COLOR;
const stdout = process.stdout as NodeJS.WriteStream;
const stdoutRestoreStack: Array<() => void> = [];

function overrideStdoutProperty<Key extends 'isTTY' | 'columns'>(
  property: Key,
  value: NodeJS.WriteStream[Key],
): void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, property);

  Object.defineProperty(stdout, property, {
    configurable: true,
    value,
  });

  stdoutRestoreStack.push(() => {
    if (previousDescriptor) {
      Object.defineProperty(stdout, property, previousDescriptor);
      return;
    }

    Reflect.deleteProperty(stdout, property);
  });
}

afterEach(() => {
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }

  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }

  while (stdoutRestoreStack.length > 0) {
    const restore = stdoutRestoreStack.pop();
    restore?.();
  }
});

describe('renderTerminalTable', () => {
  it('renders compact model names by default', () => {
    const rendered = renderTerminalTable(sampleRows, { useColor: false });

    expect(rendered).toMatchInlineSnapshot(`
      "╭────────────┬──────────┬──────────────────────────────────┬───────┬────────┬───────────┬────────────┬─────────────┬───────┬───────╮
      │ Period     │ Source   │ Models                           │ Input │ Output │ Reasoning │ Cache Read │ Cache Write │ Total │  Cost │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ 2026-02-10 │ pi       │ • gpt-4.1                        │ 1,234 │    321 │         0 │         30 │           0 │ 1,585 │ $1.25 │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ 2026-02-10 │ combined │ • gpt-4.1                        │ 2,000 │    500 │       120 │        100 │           0 │ 2,720 │ $2.75 │
      │            │          │ • gpt-5-codex                    │       │        │           │            │             │       │       │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ ALL        │ TOTAL    │ • gpt-4.1                        │ 2,000 │    500 │       120 │        100 │           0 │ 2,720 │ $2.75 │
      │            │          │ • gpt-5-codex                    │       │        │           │            │             │       │       │
      ╰────────────┴──────────┴──────────────────────────────────┴───────┴────────┴───────────┴────────────┴─────────────┴───────┴───────╯"
    `);
    expect(rendered).toContain('• gpt-4.1');
    expect(rendered).not.toContain('tok, $');
    expect(rendered.includes(`${String.fromCharCode(27)}[`)).toBe(false);
  });

  it('renders per-model aligned columns when enabled', () => {
    const rendered = renderTerminalTable(sampleRows, {
      useColor: false,
      tableLayout: 'per_model_columns',
    });

    expect(rendered).toMatchInlineSnapshot(`
      "╭────────────┬──────────┬──────────────────────────────────┬───────┬────────┬───────────┬────────────┬─────────────┬───────┬───────╮
      │ Period     │ Source   │ Models                           │ Input │ Output │ Reasoning │ Cache Read │ Cache Write │ Total │  Cost │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ 2026-02-10 │ pi       │ • gpt-4.1                        │ 1,234 │    321 │         0 │         30 │           0 │ 1,585 │ $1.25 │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ 2026-02-10 │ combined │ • gpt-4.1                        │ 1,234 │    321 │         0 │         30 │           0 │ 1,585 │ $1.25 │
      │            │          │ • gpt-5-codex                    │   766 │    179 │       120 │         70 │           0 │ 1,135 │ $1.50 │
      │            │          │ Σ TOTAL                          │ 2,000 │    500 │       120 │        100 │           0 │ 2,720 │ $2.75 │
      ├────────────┼──────────┼──────────────────────────────────┼───────┼────────┼───────────┼────────────┼─────────────┼───────┼───────┤
      │ ALL        │ TOTAL    │ • gpt-4.1                        │ 1,234 │    321 │         0 │         30 │           0 │ 1,585 │ $1.25 │
      │            │          │ • gpt-5-codex                    │   766 │    179 │       120 │         70 │           0 │ 1,135 │ $1.50 │
      │            │          │ Σ TOTAL                          │ 2,000 │    500 │       120 │        100 │           0 │ 2,720 │ $2.75 │
      ╰────────────┴──────────┴──────────────────────────────────┴───────┴────────┴───────────┴────────────┴─────────────┴───────┴───────╯"
    `);
    expect(rendered).toContain('Σ TOTAL');
    expect(rendered).toContain('│   766 │    179 │       120 │         70 │');
  });

  it('top-aligns period/source while keeping compact numeric columns vertically centered', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-01-01',
          source: 'pi',
          models: ['a', 'b', 'c'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['a', 'b', 'c'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
      ],
      { useColor: false },
    );

    expect(rendered).toContain(
      '│ 2026-01-01 │ pi     │ • a                              │       │',
    );
    expect(rendered).toContain(
      '│            │        │ • b                              │   100 │',
    );
    expect(rendered).toContain(
      '│            │        │ • c                              │       │',
    );
  });

  it('wraps long model words in the fixed-width models column', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-01-01',
          source: 'pi',
          models: ['superlongmodelnamewithoutspacesabcdefghijklmno1234567890'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['superlongmodelnamewithoutspacesabcdefghijklmno1234567890'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
      ],
      { useColor: false },
    );

    expect(rendered).toContain('│ •                                │');
    expect(rendered).toContain('superlongmodelnamewithoutspacesa');
    expect(rendered).toContain('bcdefghijklmno1234567890');
  });

  it('keeps borders aligned for full-width unicode model names', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-01-01',
          source: 'pi',
          models: ['漢字モデル'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['漢字モデル'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
      ],
      { useColor: false },
    );

    const lineWidths = rendered
      .trimEnd()
      .split('\n')
      .map((line) => visibleWidth(line));

    expect(new Set(lineWidths)).toEqual(new Set([lineWidths[0]]));
  });

  it('keeps borders aligned for text-presentation symbol model names', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-01-01',
          source: 'pi',
          models: ['©™✈'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['©™✈'],
          modelBreakdown: [],
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 120,
          costUsd: 1.23,
        },
      ],
      { useColor: false },
    );

    const lineWidths = rendered
      .trimEnd()
      .split('\n')
      .map((line) => visibleWidth(line));

    expect(new Set(lineWidths)).toEqual(new Set([lineWidths[0]]));
  });

  it('normalizes CRLF content so terminal output does not contain carriage returns', () => {
    const rows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-01-01',
        source: 'pi',
        models: ['model-a'],
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
        models: ['model-a'],
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
    ];

    const uncolored = renderTerminalTable(rows, { useColor: false });
    const colored = renderTerminalTable(rows, { useColor: true });

    expect(uncolored).not.toContain('\r');
    expect(colored).not.toContain('\r');
  });

  it('keeps structural separators stable when color is enabled', () => {
    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
    const stripAnsi = (value: string) => value.replaceAll(ansiPattern, '');

    const uncolored = renderTerminalTable(sampleRows, { useColor: false });
    const colored = renderTerminalTable(sampleRows, { useColor: true });

    expect(stripAnsi(colored)).toBe(uncolored);
  });

  it('keeps unknown sources unchanged and still renders output', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'pi',
          models: ['gpt-4.1'],
          modelBreakdown: [
            {
              model: 'gpt-4.1',
              inputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 2,
              costUsd: 0.01,
            },
          ],
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: 0.01,
        },
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'other' as UsageReportRow['source'],
          models: ['x-model'],
          modelBreakdown: [
            {
              model: 'x-model',
              inputTokens: 2,
              outputTokens: 2,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 4,
              costUsd: 0.02,
            },
          ],
          inputTokens: 2,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 4,
          costUsd: 0.02,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['gpt-4.1', 'x-model'],
          modelBreakdown: [
            {
              model: 'gpt-4.1',
              inputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 2,
              costUsd: 0.01,
            },
            {
              model: 'x-model',
              inputTokens: 2,
              outputTokens: 2,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 4,
              costUsd: 0.02,
            },
          ],
          inputTokens: 3,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
          costUsd: 0.03,
        },
      ],
      { useColor: false },
    );

    expect(rendered).toContain(' other ');
    expect(rendered).toContain(' x-model ');
  });

  it('draws separators between same-period source rows, even for combined/TOTAL literals', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'combined' as UsageReportRow['source'],
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: 0.01,
        },
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'TOTAL' as UsageReportRow['source'],
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 2,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 4,
          costUsd: 0.02,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 3,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
          costUsd: 0.03,
        },
      ],
      { useColor: false },
    );

    const separatorLines = rendered.split('\n').filter((line) => line.startsWith('├'));

    expect(separatorLines).toHaveLength(3);
  });

  it('draws separators between same-period source detail rows for clearer grouping', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'pi',
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: 0.01,
        },
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'opencode',
          models: ['gpt-5.2'],
          modelBreakdown: [],
          inputTokens: 2,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 4,
          costUsd: 0.02,
        },
        {
          rowType: 'period_combined',
          periodKey: '2026-02-10',
          source: 'combined',
          models: ['gpt-4.1', 'gpt-5.2'],
          modelBreakdown: [],
          inputTokens: 3,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
          costUsd: 0.03,
        },
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['gpt-4.1', 'gpt-5.2'],
          modelBreakdown: [],
          inputTokens: 3,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
          costUsd: 0.03,
        },
      ],
      { useColor: false },
    );

    const separatorLines = rendered.split('\n').filter((line) => line.startsWith('├'));

    expect(separatorLines).toHaveLength(4);
  });

  it('normalizes row grouping before separator decisions when input rows are out of order', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 3,
          outputTokens: 3,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
          costUsd: 0.03,
        },
        {
          rowType: 'period_combined',
          periodKey: '2026-02-10',
          source: 'combined',
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 2,
          outputTokens: 2,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 4,
          costUsd: 0.02,
        },
        {
          rowType: 'period_source',
          periodKey: '2026-02-10',
          source: 'pi',
          models: ['gpt-4.1'],
          modelBreakdown: [],
          inputTokens: 1,
          outputTokens: 1,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: 0.01,
        },
      ],
      { useColor: false },
    );

    const lines = rendered.split('\n');
    const periodSourceLineIndex = lines.findIndex((line) => line.includes('│ 2026-02-10 │ pi'));
    const periodCombinedLineIndex = lines.findIndex((line) =>
      line.includes('│ 2026-02-10 │ combined'),
    );
    const grandTotalLineIndex = lines.findIndex((line) => line.includes('│ ALL        │ TOTAL'));
    const separatorLines = lines.filter((line) => line.startsWith('├'));

    expect(periodSourceLineIndex).toBeGreaterThan(-1);
    expect(periodCombinedLineIndex).toBeGreaterThan(-1);
    expect(grandTotalLineIndex).toBeGreaterThan(-1);
    expect(periodSourceLineIndex).toBeLessThan(periodCombinedLineIndex);
    expect(periodCombinedLineIndex).toBeLessThan(grandTotalLineIndex);
    expect(separatorLines).toHaveLength(3);
  });

  it('renders unknown cost values as "-" instead of NaN', () => {
    const rendered = renderTerminalTable(
      [
        {
          rowType: 'period_source',
          periodKey: '2026-01-01',
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
      ],
      { useColor: false },
    );

    expect(rendered).toContain('│    - │');
    expect(rendered).not.toContain('NaN');
  });

  it('ignores invalid tty width metadata when no explicit terminal width override is set', () => {
    overrideStdoutProperty('isTTY', true);
    overrideStdoutProperty('columns', 0);

    const withInvalidColumns = renderTerminalTable(sampleRows, { useColor: false });
    overrideStdoutProperty('columns', undefined as unknown as NodeJS.WriteStream['columns']);
    const unconstrained = renderTerminalTable(sampleRows, { useColor: false });

    expect(withInvalidColumns).toBe(unconstrained);
  });

  it('shrinks models column when terminal width is constrained', () => {
    const unconstrained = renderTerminalTable(sampleRows, {
      useColor: false,
      terminalWidth: 200,
    });
    const constrained = renderTerminalTable(sampleRows, {
      useColor: false,
      terminalWidth: 118,
    });

    const unconstrainedWidth = unconstrained
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
    const constrainedWidth = constrained
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);

    expect(constrainedWidth).toBeLessThan(unconstrainedWidth);
    expect(constrainedWidth).toBeLessThanOrEqual(118);
  });

  it('uses spare width to pack compact model lists into fewer lines', () => {
    const denseRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-03',
        source: 'combined',
        models: [
          'antigravity-gemini-3-flash',
          'antigravity-gemini-3-pro',
          'antigravity-gemini-3-pro-high',
          'claude-haiku-4.5',
          'claude-opus-4.5',
          'claude-opus-4.6',
          'claude-sonnet-4.5',
          'claude-sonnet-4.6',
        ],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [
          'antigravity-gemini-3-flash',
          'antigravity-gemini-3-pro',
          'antigravity-gemini-3-pro-high',
          'claude-haiku-4.5',
          'claude-opus-4.5',
          'claude-opus-4.6',
          'claude-sonnet-4.5',
          'claude-sonnet-4.6',
        ],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
    ];

    const defaultRendered = renderTerminalTable(denseRows, {
      useColor: false,
      terminalWidth: 132,
    });
    const expandedRendered = renderTerminalTable(denseRows, {
      useColor: false,
      terminalWidth: 180,
    });

    const defaultWidth = defaultRendered
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
    const expandedWidth = expandedRendered
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
    const defaultLineCount = defaultRendered.trimEnd().split('\n').length;
    const expandedLineCount = expandedRendered.trimEnd().split('\n').length;

    expect(expandedWidth).toBeGreaterThanOrEqual(defaultWidth);
    expect(expandedWidth).toBeLessThan(180);
    expect(expandedLineCount).toBeLessThan(defaultLineCount);
    expect(expandedRendered).toMatch(
      /• antigravity-gemini-3-flash\s{2,}• antigravity-gemini-3-pro/u,
    );
  });

  it('widens compact tables to avoid wrapping single packed model columns when space allows', () => {
    const longModelRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-03',
        source: 'pi',
        models: ['primary-model-name-with-extra-suffix', 'secondary-model-name-with-suffix'],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['primary-model-name-with-extra-suffix', 'secondary-model-name-with-suffix'],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
    ];

    const constrainedRendered = renderTerminalTable(longModelRows, {
      useColor: false,
      terminalWidth: 128,
    });
    const expandedRendered = renderTerminalTable(longModelRows, {
      useColor: false,
      terminalWidth: 138,
    });

    expect(constrainedRendered).toContain('primary-model-name-with-extra-s');
    expect(expandedRendered).toContain('• primary-model-name-with-extra-suffix');
    expect(expandedRendered).toContain('• secondary-model-name-with-suffix');
    expect(expandedRendered.trimEnd().split('\n').length).toBeLessThan(
      constrainedRendered.trimEnd().split('\n').length,
    );
  });

  it('keeps single-model rows unchanged when compact tables widen for other rows', () => {
    const mixedRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-03',
        source: 'pi',
        models: ['only-model'],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [
          'antigravity-gemini-3-flash',
          'antigravity-gemini-3-pro',
          'antigravity-gemini-3-pro-high',
          'claude-haiku-4.5',
          'claude-opus-4.5',
          'claude-opus-4.6',
          'claude-sonnet-4.5',
          'claude-sonnet-4.6',
        ],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: 1.23,
      },
    ];

    const rendered = renderTerminalTable(mixedRows, {
      useColor: false,
      terminalWidth: 180,
    });

    expect(rendered).toContain('│ 2026-03 │ pi     │ • only-model');
    expect(rendered).toMatch(/• antigravity-gemini-3-flash\s{2,}• antigravity-gemini-3-pro/u);
  });

  it('expands per-model tables modestly instead of filling the full terminal width', () => {
    const defaultRendered = renderTerminalTable(sampleRows, {
      useColor: false,
      tableLayout: 'per_model_columns',
      terminalWidth: 132,
    });
    const expandedRendered = renderTerminalTable(sampleRows, {
      useColor: false,
      tableLayout: 'per_model_columns',
      terminalWidth: 180,
    });

    const defaultWidth = defaultRendered
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
    const expandedWidth = expandedRendered
      .trimEnd()
      .split('\n')
      .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);

    expect(expandedWidth).toBeGreaterThan(defaultWidth);
    expect(expandedWidth).toBeLessThan(180);
  });

  it('throws when explicit terminal width override is too narrow to render table', () => {
    expect(() =>
      renderTerminalTable(sampleRows, {
        useColor: false,
        terminalWidth: 40,
      }),
    ).toThrow('Configured terminal width (40) is too narrow for table rendering');
  });
});

describe('shouldUseColorByDefault', () => {
  it('returns false when FORCE_COLOR=0', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '0';
    overrideStdoutProperty('isTTY', true);

    expect(shouldUseColorByDefault()).toBe(false);
  });

  it('returns true when FORCE_COLOR is a non-zero value', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    overrideStdoutProperty('isTTY', false);

    expect(shouldUseColorByDefault()).toBe(true);
  });

  it('returns false when stdout is not a tty and no color env override is set', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    overrideStdoutProperty('isTTY', false);

    expect(shouldUseColorByDefault()).toBe(false);
  });
});
