import { describe, expect, it } from 'vitest';

import { toEfficiencyTableCells } from '../../src/render/efficiency-row-cells.js';

describe('efficiency-row-cells', () => {
  it('renders dash placeholders when derived USD values are unavailable', () => {
    const cells = toEfficiencyTableCells([
      {
        rowType: 'period',
        periodKey: '2026-02',
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: undefined,
        commitCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesChanged: 0,
        usdPerCommit: undefined,
        usdPer1kLinesChanged: undefined,
        tokensPerCommit: undefined,
        commitsPerUsd: undefined,
      },
    ]);

    expect(cells[0]?.[11]).toBe('-');
    expect(cells[0]?.[12]).toBe('-');
    expect(cells[0]?.[13]).toBe('-');
  });

  it('prefixes approximate costs when pricing is incomplete', () => {
    const cells = toEfficiencyTableCells([
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        cacheReadTokens: 15,
        cacheWriteTokens: 0,
        totalTokens: 175,
        costUsd: 2.5,
        costIncomplete: true,
        commitCount: 2,
        linesAdded: 20,
        linesDeleted: 5,
        linesChanged: 25,
        usdPerCommit: 1.25,
        usdPer1kLinesChanged: 100,
        tokensPerCommit: 80,
        commitsPerUsd: 0.8,
      },
    ]);

    expect(cells[0]?.[11]).toBe('~$2.50');
    expect(cells[0]?.[12]).toBe('~$1.2500');
    expect(cells[0]?.[15]).toBe('~0.80');
  });
});
