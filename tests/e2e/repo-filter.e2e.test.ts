import { describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createE2eSourceOptions, type SourceOptions } from '../golden/golden-harness.js';
import {
  createProjectFixtureAdapters,
  PROJECT_FIXTURE_EVENTS,
} from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

type ExportedEvent = { source: string; repoRoot?: string };

type EventsRun = { events: ExportedEvent[]; stderr: string };

async function exportEvents(
  options: EventsCommandOptions,
  deps: Parameters<typeof runEventsReport>[1] = {},
): Promise<EventsRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(`${args.map(String).join(' ')}\n`);
  });

  try {
    await runEventsReport({ timezone: 'UTC', pricingOffline: true, ...options }, deps);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const lines = stdout.join('').trimEnd();
  return {
    events: lines.length === 0 ? [] : lines.split('\n').map((line) => JSON.parse(line) as never),
    stderr: stderr.join(''),
  };
}

function countByRoot(events: readonly ExportedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    const root = event.repoRoot ?? '(none)';
    counts[root] = (counts[root] ?? 0) + 1;
  }

  return counts;
}

describe('--repo e2e', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  let e2eSourceOptions: SourceOptions | undefined;

  /** The e2e fixtures of every source, copied under the temp root once. */
  async function e2eSources(): Promise<SourceOptions> {
    e2eSourceOptions ??= await createE2eSourceOptions(environment.rootDir);
    return e2eSourceOptions;
  }

  it('keeps only the selected projects of the e2e fixtures, and everything without --repo', async () => {
    const sources = await e2eSources();
    const all = await exportEvents({ ...sources });
    const attributed = countByRoot(all.events);

    expect(attributed).toMatchObject({
      '/home/dev/projects/dsh-e2e': 3,
      '/tmp/claude-e2e': 2,
      '/tmp/droid-e2e': 2,
      '/tmp/gemini-e2e': 2,
      '/tmp/openclaw-e2e': 1,
    });

    // A path matches the roots under it; a name matches the last segment.
    expect(countByRoot((await exportEvents({ ...sources, repo: '/tmp' })).events)).toEqual({
      '/tmp/claude-e2e': 2,
      '/tmp/droid-e2e': 2,
      '/tmp/gemini-e2e': 2,
      '/tmp/openclaw-e2e': 1,
    });
    expect(
      countByRoot((await exportEvents({ ...sources, repo: ['dsh-e2e', 'claude-e2e'] })).events),
    ).toEqual({ '/home/dev/projects/dsh-e2e': 3, '/tmp/claude-e2e': 2 });

    const unattributed = await exportEvents({ ...sources, repo: '(unattributed)' });
    expect(unattributed.events.length).toBe(all.events.length - 10);
    expect(unattributed.events.every((event) => event.repoRoot === undefined)).toBe(true);
  });

  it('warns on stderr for a value that selects nothing, and keeps stdout data-only', async () => {
    const sources = await e2eSources();
    const run = await exportEvents({ ...sources, repo: 'claude-e2f,gemini-e2e' });

    expect(countByRoot(run.events)).toEqual({ '/tmp/gemini-e2e': 2 });
    expect(run.stderr).toContain('--repo claude-e2f matched no usage (did you mean claude-e2e?)');
    expect(run.stderr).not.toContain('--repo gemini-e2e');
  });

  it('filters the synthetic project fixture by path, label and trailing separator', async () => {
    const deps = { createAdapters: createProjectFixtureAdapters };
    const byLabel = await exportEvents({ repo: 'b/api' }, deps);
    const byPath = await exportEvents({ repo: '/w/a/api' }, deps);

    expect(countByRoot(byLabel.events)).toEqual({ '/w/b/api': 2, '/w/b/api/': 1 });
    expect(countByRoot(byPath.events)).toEqual({ '/w/a/api': 3, '/w/a/api/src': 1 });
    expect(countByRoot((await exportEvents({ repo: 'C:/src' }, deps)).events)).toEqual({
      'C:\\src\\web': 2,
    });
  });

  it('totals a usage report over the selected projects only', async () => {
    const result = await buildUsageData(
      'monthly',
      { repo: 'api', timezone: 'UTC', pricingOffline: true },
      { createAdapters: createProjectFixtureAdapters },
    );
    const grandTotal = result.rows.find((row) => row.rowType === 'grand_total');
    const expectedTokens = PROJECT_FIXTURE_EVENTS.filter((event) =>
      ['/w/a/api', '/w/b/api', '/w/b/api/'].includes(event.repoRoot ?? ''),
    ).reduce((sum, event) => sum + event.totalTokens, 0);

    expect(grandTotal?.totalTokens).toBe(expectedTokens);
  });
});
