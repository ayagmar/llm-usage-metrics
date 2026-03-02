import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/run-efficiency-report.js', () => ({
  runEfficiencyReport: vi.fn(async () => undefined),
}));

vi.mock('../../src/cli/run-usage-report.js', () => ({
  runUsageReport: vi.fn(async () => undefined),
}));

vi.mock('../../src/cli/run-optimize-report.js', () => ({
  runOptimizeReport: vi.fn(async () => undefined),
}));

import { createCli } from '../../src/cli/create-cli.js';
import { runOptimizeReport } from '../../src/cli/run-optimize-report.js';

describe('createCli optimize command parsing', () => {
  it('normalizes granularity and dispatches to runOptimizeReport', async () => {
    const cli = createCli();
    const runOptimizeReportMock = vi.mocked(runOptimizeReport);

    await cli.parseAsync(
      ['optimize', ' monthly ', '--candidate-model', 'gpt-4.1', '--json', '--top', '1', '--share'],
      {
        from: 'user',
      },
    );

    expect(runOptimizeReportMock).toHaveBeenCalledTimes(1);
    expect(runOptimizeReportMock).toHaveBeenCalledWith(
      'monthly',
      expect.objectContaining({
        candidateModel: ['gpt-4.1'],
        json: true,
        top: '1',
        share: true,
      }),
    );
  });

  it('rejects unsupported optimize granularity values', async () => {
    const cli = createCli();
    cli.exitOverride();

    await expect(cli.parseAsync(['optimize', 'yearly'], { from: 'user' })).rejects.toThrow(
      'Invalid granularity: yearly. Expected one of: daily, weekly, monthly',
    );
  });

  it('does not expose --per-model-columns on optimize command', () => {
    const cli = createCli();
    const optimizeCommand = cli.commands.find((command) => command.name() === 'optimize');

    expect(optimizeCommand).toBeDefined();
    expect(optimizeCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });
});
