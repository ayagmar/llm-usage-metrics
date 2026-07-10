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

vi.mock('../../src/cli/run-trends-report.js', () => ({
  runTrendsReport: vi.fn(async () => undefined),
}));

vi.mock('../../src/cli/run-session-report.js', () => ({
  runSessionReport: vi.fn(async () => undefined),
}));

vi.mock('../../src/cli/run-wrapped-report.js', () => ({
  runWrappedReport: vi.fn(async () => undefined),
}));

import { createCli } from '../../src/cli/create-cli.js';
import { runWrappedReport } from '../../src/cli/run-wrapped-report.js';

describe('createCli wrapped command parsing', () => {
  it('dispatches to runWrappedReport with wrapped-specific options', async () => {
    const cli = createCli();
    const runWrappedReportMock = vi.mocked(runWrappedReport);

    await cli.parseAsync(
      ['wrapped', '--year', '2026', '--share', '--json', '--source', 'pi,codex'],
      { from: 'user' },
    );

    expect(runWrappedReportMock).toHaveBeenCalledTimes(1);
    expect(runWrappedReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        year: '2026',
        share: true,
        json: true,
        source: ['pi,codex'],
      }),
    );
  });

  it('exposes provider/model filters but not date or markdown filters on wrapped command', () => {
    const cli = createCli();
    const wrappedCommand = cli.commands.find((command) => command.name() === 'wrapped');

    expect(wrappedCommand).toBeDefined();
    expect(wrappedCommand?.options.some((option) => option.long === '--provider')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--model')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--since')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--until')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--markdown')).toBe(false);
  });
});
