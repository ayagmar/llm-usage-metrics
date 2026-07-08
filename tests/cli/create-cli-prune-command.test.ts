import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/run-prune-report.js', () => ({
  runPruneReport: vi.fn(async () => undefined),
}));

import { createCli } from '../../src/cli/create-cli.js';
import { runPruneReport } from '../../src/cli/run-prune-report.js';

describe('createCli prune command parsing', () => {
  it('dispatches to runPruneReport with prune-specific options', async () => {
    const cli = createCli();
    const runPruneReportMock = vi.mocked(runPruneReport);

    await cli.parseAsync(
      [
        'prune',
        '--suppressed',
        '--departed-before',
        '2026-01-01',
        '--apply',
        '--json',
        '--source',
        'codex',
      ],
      { from: 'user' },
    );

    expect(runPruneReportMock).toHaveBeenCalledTimes(1);
    expect(runPruneReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressed: true,
        departedBefore: '2026-01-01',
        apply: true,
        json: true,
        source: ['codex'],
      }),
    );
  });
});
