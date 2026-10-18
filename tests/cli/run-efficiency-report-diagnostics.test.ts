import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ShareReportArtifactModule from '../../src/cli/share-report-artifact.js';
import type { EfficiencyDataResult } from '../../src/cli/usage-data-contracts.js';

vi.mock('../../src/cli/build-efficiency-data.js', () => ({
  buildEfficiencyData: vi.fn(),
}));

vi.mock('../../src/cli/share-report-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ShareReportArtifactModule>()),
  buildShareReportArtifact: vi.fn(async () => ({
    fileName: 'efficiency-monthly-share.html',
    logLabel: 'efficiency',
    render: () => '',
  })),
}));

vi.mock('../../src/cli/share-artifact.js', () => ({
  writeShareFile: vi.fn(async (fileName: string) => `/share/${fileName}`),
  openShareFile: vi.fn(),
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

async function runStderr(
  data: EfficiencyDataResult,
  options: Parameters<typeof runEfficiencyReport>[1] = {},
): Promise<string> {
  vi.mocked(buildEfficiencyData).mockResolvedValue(data);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await runEfficiencyReport('monthly', options);

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

  it('names the repository, except with --share --redact', async () => {
    const data = efficiencyData({ repoDir: '/home/alice/acme-client' });

    expect(await runStderr(data)).toContain('lines (/home/alice/acme-client)');
    vi.restoreAllMocks();

    const redacted = await runStderr(data, { share: true, open: false, redact: true });

    expect(redacted).toContain('Git outcomes (excluding merge commits): 0 commits, +0/-0 lines');
    expect(redacted).not.toContain('acme-client');
  });
});
