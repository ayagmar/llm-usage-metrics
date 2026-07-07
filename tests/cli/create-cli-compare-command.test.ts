import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/run-compare-report.js', () => ({
  runCompareReport: vi.fn(async () => undefined),
}));

import { createCli } from '../../src/cli/create-cli.js';
import { runCompareReport } from '../../src/cli/run-compare-report.js';

describe('createCli compare command parsing', () => {
  it('dispatches to runCompareReport with compare-specific options', async () => {
    const cli = createCli();
    const runCompareReportMock = vi.mocked(runCompareReport);

    await cli.parseAsync(
      [
        'compare',
        '--since',
        '2026-06-01',
        '--until',
        '2026-06-30',
        '--vs-since',
        '2026-05-01',
        '--vs-until',
        '2026-05-31',
        '--history',
        '--json',
      ],
      { from: 'user' },
    );

    expect(runCompareReportMock).toHaveBeenCalledTimes(1);
    expect(runCompareReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        since: '2026-06-01',
        until: '2026-06-30',
        vsSince: '2026-05-01',
        vsUntil: '2026-05-31',
        history: true,
        json: true,
      }),
    );
  });
});
