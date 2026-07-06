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

import { createCli } from '../../src/cli/create-cli.js';
import { runSessionReport } from '../../src/cli/run-session-report.js';

describe('createCli session command parsing', () => {
  it('dispatches to runSessionReport with session-specific options', async () => {
    const cli = createCli();
    const runSessionReportMock = vi.mocked(runSessionReport);

    await cli.parseAsync(
      [
        'session',
        '--json',
        '--top',
        '2',
        '--markdown',
        '--source',
        'pi,codex',
        '--id',
        '486c',
        '--id',
        'abc,def',
      ],
      { from: 'user' },
    );

    expect(runSessionReportMock).toHaveBeenCalledTimes(1);
    expect(runSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        markdown: true,
        top: '2',
        source: ['pi,codex'],
        id: ['486c', 'abc,def'],
      }),
    );
  });

  it('dispatches by-repo grouping to runSessionReport', async () => {
    const cli = createCli();
    const runSessionReportMock = vi.mocked(runSessionReport);
    runSessionReportMock.mockClear();

    await cli.parseAsync(['session', '--by-repo', '--top', '5'], { from: 'user' });

    expect(runSessionReportMock).toHaveBeenCalledTimes(1);
    expect(runSessionReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        byRepo: true,
        top: '5',
      }),
    );
  });

  it('does not expose share or per-model columns on session command', () => {
    const cli = createCli();
    const sessionCommand = cli.commands.find((command) => command.name() === 'session');

    expect(sessionCommand).toBeDefined();
    expect(sessionCommand?.options.some((option) => option.long === '--share')).toBe(false);
    expect(sessionCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });
});
