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

import { createCli } from '../../src/cli/create-cli.js';
import { runTrendsReport } from '../../src/cli/run-trends-report.js';

describe('createCli trends command parsing', () => {
  it('dispatches to runTrendsReport with trends-specific options', async () => {
    const cli = createCli();
    const runTrendsReportMock = vi.mocked(runTrendsReport);

    await cli.parseAsync(['trends', '--days', '7', '--metric', 'tokens', '--by-source', '--json'], {
      from: 'user',
    });

    expect(runTrendsReportMock).toHaveBeenCalledTimes(1);
    expect(runTrendsReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        days: '7',
        metric: 'tokens',
        bySource: true,
        json: true,
      }),
    );
  });
});
