import { afterEach, describe, expect, it } from 'vitest';

import { aggregateBlocks, type UsageBlock } from '../../src/blocks/aggregate-blocks.js';
import type { BlockRow, BlocksReportData } from '../../src/cli/build-blocks-data.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { renderBlocksReport } from '../../src/render/render-blocks-report.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

function blockRows(): BlockRow[] {
  const [uncertain, active] = aggregateBlocks(
    [
      createUsageEvent({
        source: 'claude',
        sessionId: 's',
        timestamp: '2026-06-20T22:30:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_234_567,
        outputTokens: 1_000,
        reasoningTokens: 500,
        totalTokens: 1_235_567,
        costUsd: 1.5,
      }),
      createUsageEvent({
        source: 'claude',
        sessionId: 's',
        timestamp: '2026-06-21T10:15:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 2_000,
        outputTokens: 300,
      }),
    ],
    {
      sinceMs: Date.parse('2026-06-15T00:00:00.000Z'),
      rangeStartMs: Date.parse('2026-06-20T20:00:00.000Z'),
    },
  ) as [UsageBlock, UsageBlock];

  return [
    { ...uncertain, active: null },
    { ...active, active: { remainingMinutes: 180, tokensPerHour: 1_150 } },
  ];
}

function reportData(blocks: BlockRow[]): BlocksReportData {
  return {
    estimated: true,
    blockHours: 5,
    timezone: 'Asia/Kolkata',
    since: '2026-06-15',
    until: null,
    top: { count: 2, rankedBy: 'tokens' },
    blockCount: 5,
    blocks,
    activeBlocks: blocks.filter((block) => block.active !== null),
  };
}

describe('renderBlocksReport', () => {
  let restoreStdout: (() => void) | undefined;

  afterEach(() => {
    restoreStdout?.();
    restoreStdout = undefined;
  });

  it('prints a table in local time that says the blocks are estimated', () => {
    restoreStdout = overrideStdoutTty(200);
    const output = renderBlocksReport(reportData(blockRows()), 'terminal', { useColor: false });

    expect(output).toContain('Estimated 5-Hour Usage Blocks');
    // 22:00 UTC is 03:30 the next day in Kolkata; the block crosses midnight UTC.
    expect(output).toContain('2026-06-21 03:30-08:30*');
    expect(output).toContain('2026-06-21 15:30-20:30 (active)');
    expect(output).toContain('1,234,567');
    expect(output).toContain('Reasoning');
    expect(output).toContain('$1.50');
    expect(output).toContain('* Start uncertain');
    expect(output).toContain('Top 2 of 5 blocks by tokens.');
    expect(output).toContain(
      'Active block (estimated), claude: ends 2026-06-21 20:30, 180 min left, burn rate 1,150 tokens/h.',
    );
  });

  it('abbreviates tokens and leaves out minor columns and cost when asked', () => {
    restoreStdout = overrideStdoutTty(200);
    const output = renderBlocksReport(reportData(blockRows()), 'terminal', {
      useColor: false,
      compact: true,
      hideCost: true,
    });

    expect(output).toContain('1.23M');
    expect(output).not.toContain('Reasoning');
    expect(output).not.toContain('Cache Write');
    expect(output).not.toContain('Cost');
    expect(output).not.toContain('$');
  });

  it('shows the cost burn rate unless cost is hidden, marking an incomplete one', () => {
    const [, active] = blockRows() as [BlockRow, BlockRow];
    const data = reportData([
      {
        ...active,
        active: { remainingMinutes: 10, tokensPerHour: 5, costUsdPerHour: 2, costIncomplete: true },
      },
    ]);

    expect(renderBlocksReport(data, 'markdown')).toContain('burn rate \\~$2.00/h, 5 tokens/h.');
    expect(renderBlocksReport(data, 'markdown', { hideCost: true })).toContain(
      'burn rate 5 tokens/h.',
    );
  });

  it('says estimated when there is nothing to show', () => {
    const empty = { ...reportData([]), top: null, blockCount: 0 };

    expect(renderBlocksReport(empty, 'terminal', { useColor: false })).toContain(
      'Estimated 5-Hour Usage Blocks',
    );
    expect(renderBlocksReport(empty, 'terminal', { useColor: false, filtered: true })).toContain(
      'No usage data found for the selected filters.',
    );
    expect(renderBlocksReport(empty, 'markdown')).toBe(
      'Estimated 5-hour usage blocks: No usage data found.',
    );
  });

  it('wraps the data in the blocks JSON envelope', () => {
    const parsed = JSON.parse(renderBlocksReport(reportData(blockRows()), 'json')) as {
      report: string;
      data: BlocksReportData;
    };

    expect(parsed.report).toBe('blocks');
    expect(parsed.data.estimated).toBe(true);
  });
});
