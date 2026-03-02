import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/run-efficiency-report.js', () => ({
  runEfficiencyReport: vi.fn(async () => undefined),
}));

vi.mock('../../src/cli/run-usage-report.js', () => ({
  runUsageReport: vi.fn(async () => undefined),
}));

import { createCli } from '../../src/cli/create-cli.js';
import { runEfficiencyReport } from '../../src/cli/run-efficiency-report.js';

describe('createCli efficiency command parsing', () => {
  it('normalizes granularity and dispatches to runEfficiencyReport', async () => {
    const cli = createCli();
    const runEfficiencyReportMock = vi.mocked(runEfficiencyReport);

    await cli.parseAsync(
      ['efficiency', ' monthly ', '--json', '--repo-dir', '/tmp/repo', '--share'],
      {
        from: 'user',
      },
    );

    expect(runEfficiencyReportMock).toHaveBeenCalledTimes(1);
    expect(runEfficiencyReportMock).toHaveBeenCalledWith(
      'monthly',
      expect.objectContaining({
        json: true,
        repoDir: '/tmp/repo',
        share: true,
      }),
    );
  });

  it('rejects unsupported efficiency granularity values', async () => {
    const cli = createCli();
    cli.exitOverride();

    await expect(cli.parseAsync(['efficiency', 'yearly'], { from: 'user' })).rejects.toThrow(
      'Invalid granularity: yearly. Expected one of: daily, weekly, monthly',
    );
  });
});
