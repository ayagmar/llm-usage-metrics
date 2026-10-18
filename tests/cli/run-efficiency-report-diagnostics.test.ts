import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EfficiencyDataResult } from '../../src/cli/usage-data-contracts.js';

vi.mock('../../src/cli/build-efficiency-data.js', () => ({
  buildEfficiencyData: vi.fn(),
}));

import { buildEfficiencyData } from '../../src/cli/build-efficiency-data.js';
import { runEfficiencyReport } from '../../src/cli/run-efficiency-report.js';

function efficiencyData(
  diagnostics: Partial<EfficiencyDataResult['diagnostics']>,
): EfficiencyDataResult {
  return {
    grouping: 'period',
    rows: [],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
      repoDir: 'repo',
      includeMergeCommits: false,
      gitCommitCount: 0,
      gitLinesAdded: 0,
      gitLinesDeleted: 0,
      gitMalformedCommitLines: 0,
      repoMatchedUsageEvents: 0,
      repoExcludedUsageEvents: 0,
      repoUnattributedUsageEvents: 0,
      ...diagnostics,
    },
  };
}

async function runStderr(data: EfficiencyDataResult): Promise<string> {
  vi.mocked(buildEfficiencyData).mockResolvedValue(data);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await runEfficiencyReport('monthly', {});

  return errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('runEfficiencyReport diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says whether merge commits count and warns about filters that narrow commit days', async () => {
    const stderr = await runStderr(
      efficiencyData({ includeMergeCommits: true, scopeNote: 'Usage filters (--model) narrow.' }),
    );

    expect(stderr).toContain('Git outcomes (including merge commits)');
    expect(stderr).toContain('Usage filters (--model) narrow.');
  });

  it.each([
    [1, 'Skipped 1 malformed git commit boundary'],
    [2, 'Skipped 2 malformed git commit boundaries'],
  ])('warns about %i malformed commit boundary lines', async (count, message) => {
    const stderr = await runStderr(efficiencyData({ gitMalformedCommitLines: count }));

    expect(stderr).toContain(message);
    expect(stderr).toContain('Git outcomes (excluding merge commits)');
  });
});
