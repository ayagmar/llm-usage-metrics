import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/run-compare-report.js', () => ({ runCompareReport: vi.fn() }));
vi.mock('../../src/cli/run-efficiency-report.js', () => ({ runEfficiencyReport: vi.fn() }));
vi.mock('../../src/cli/run-optimize-report.js', () => ({ runOptimizeReport: vi.fn() }));
vi.mock('../../src/cli/run-prune-report.js', () => ({ runPruneReport: vi.fn() }));
vi.mock('../../src/cli/run-session-report.js', () => ({ runSessionReport: vi.fn() }));
vi.mock('../../src/cli/run-trends-report.js', () => ({ runTrendsReport: vi.fn() }));
vi.mock('../../src/cli/run-usage-report.js', () => ({ runUsageReport: vi.fn() }));
vi.mock('../../src/cli/run-wrapped-report.js', () => ({ runWrappedReport: vi.fn() }));

import { createCli } from '../../src/cli/create-cli.js';
import { runCompareReport } from '../../src/cli/run-compare-report.js';
import { runEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { runOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { runPruneReport } from '../../src/cli/run-prune-report.js';
import { runSessionReport } from '../../src/cli/run-session-report.js';
import { runTrendsReport } from '../../src/cli/run-trends-report.js';
import { runUsageReport } from '../../src/cli/run-usage-report.js';
import { runWrappedReport } from '../../src/cli/run-wrapped-report.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createCli dispatch', () => {
  it.each([
    {
      runner: runCompareReport,
      argv: [
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
      expected: [
        expect.objectContaining({
          since: '2026-06-01',
          until: '2026-06-30',
          vsSince: '2026-05-01',
          vsUntil: '2026-05-31',
          history: true,
          json: true,
        }),
      ],
    },
    {
      runner: runEfficiencyReport,
      argv: [
        'efficiency',
        ' monthly ',
        '--json',
        '--repo-dir',
        '/tmp/repo',
        '--share',
        '--by-source',
      ],
      expected: [
        'monthly',
        expect.objectContaining({ json: true, repoDir: '/tmp/repo', share: true, bySource: true }),
      ],
    },
    {
      runner: runOptimizeReport,
      argv: [
        'optimize',
        ' monthly ',
        '--candidate-model',
        'gpt-4.1',
        '--json',
        '--top',
        '1',
        '--share',
      ],
      expected: [
        'monthly',
        expect.objectContaining({ candidateModel: ['gpt-4.1'], json: true, top: '1', share: true }),
      ],
    },
    {
      runner: runPruneReport,
      argv: [
        'prune',
        '--suppressed',
        '--departed-before',
        '2026-01-01',
        '--apply',
        '--json',
        '--source',
        'codex',
      ],
      expected: [
        expect.objectContaining({
          suppressed: true,
          departedBefore: '2026-01-01',
          apply: true,
          json: true,
          source: ['codex'],
        }),
      ],
    },
    {
      runner: runSessionReport,
      argv: [
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
      expected: [
        expect.objectContaining({
          json: true,
          markdown: true,
          top: '2',
          source: ['pi,codex'],
          id: ['486c', 'abc,def'],
        }),
      ],
    },
    {
      runner: runSessionReport,
      argv: ['session', '--by-repo', '--top', '5'],
      expected: [expect.objectContaining({ byRepo: true, top: '5' })],
    },
    {
      runner: runTrendsReport,
      argv: ['trends', '--days', '7', '--metric', 'tokens', '--by-source', '--json'],
      expected: [
        expect.objectContaining({ days: '7', metric: 'tokens', bySource: true, json: true }),
      ],
    },
    {
      runner: runUsageReport,
      argv: ['monthly', '--last', '3', '--no-cost'],
      expected: ['monthly', expect.objectContaining({ last: '3', cost: false })],
    },
    {
      runner: runWrappedReport,
      argv: ['wrapped', '--year', '2026', '--share', '--json', '--source', 'pi,codex'],
      expected: [
        expect.objectContaining({ year: '2026', share: true, json: true, source: ['pi,codex'] }),
      ],
    },
  ])('dispatches $argv.0 with its options', async ({ runner, argv, expected }) => {
    await createCli().parseAsync(argv, { from: 'user' });

    expect(vi.mocked(runner).mock.calls).toEqual([expected]);
  });

  it.each(['efficiency', 'optimize'])('rejects an unsupported %s granularity', async (command) => {
    const cli = createCli();
    cli.exitOverride();

    await expect(cli.parseAsync([command, 'yearly'], { from: 'user' })).rejects.toThrow(
      'Invalid granularity: yearly. Expected one of: daily, weekly, monthly',
    );
  });
});
