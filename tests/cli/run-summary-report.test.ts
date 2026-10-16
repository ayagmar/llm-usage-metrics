import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSummaryReport, SUMMARY_NEXT_STEPS_HINT } from '../../src/cli/run-summary-report.js';
import * as shareArtifact from '../../src/cli/share-artifact.js';
import { runUsageReport } from '../../src/cli/run-usage-report.js';
import { readSharePayload } from '../helpers/share-html.js';

const tempDirs: string[] = [];

function daysBetween(since: string, until: string): number {
  return (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function emptySourceOptions() {
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'summary-run-'));
  tempDirs.push(emptyDir);
  return { piDir: emptyDir, codexDir: emptyDir, source: ['pi', 'codex'], timezone: 'UTC' };
}

async function captureRun(run: () => Promise<void>) {
  const order: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
    order.push(`stderr:${String(value)}`);
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    order.push(`stdout:${String(value)}`);
  });

  try {
    await run();
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }

  return order;
}

describe('runSummaryReport', () => {
  it('prints the next-steps hint after the terminal summary', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runSummaryReport(options));
    const outputIndex = order.findIndex((line) => line.startsWith('stdout:'));

    expect(order[outputIndex]).toContain('Usage summary for');
    expect(
      order.slice(outputIndex + 1).some((line) => line.includes(SUMMARY_NEXT_STEPS_HINT)),
    ).toBe(true);
  });

  it('writes the activity share report with --share', async () => {
    const options = await emptySourceOptions();
    const shareDir = await mkdtemp(path.join(os.tmpdir(), 'summary-share-'));
    tempDirs.push(shareDir);
    const openSpy = vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
    const previousCwd = process.cwd();
    process.chdir(shareDir);

    try {
      const order = await captureRun(() => runSummaryReport({ ...options, share: true }));

      expect(order.find((line) => line.startsWith('stdout:'))).toContain('Usage summary for');
      expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/summary-share\.html$/u));
    } finally {
      process.chdir(previousCwd);
      openSpy.mockRestore();
    }

    expect(await readdir(shareDir)).toEqual(['summary-share.html']);
    const { data } = readSharePayload(
      await readFile(path.join(shareDir, 'summary-share.html'), 'utf8'),
    );
    // The activity grid's 53 weeks, ending today.
    const { since, until } = data.meta.window;
    expect(data.meta.initialView).toEqual({ since, until, granularity: 'week' });
    expect(until).toBe(new Date().toISOString().slice(0, 10));
    expect(daysBetween(since ?? '', until ?? '')).toBeGreaterThanOrEqual(52 * 7);
  });

  it('keeps JSON output free of the hint', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runSummaryReport({ ...options, json: true }));

    expect(order.some((line) => line.includes(SUMMARY_NEXT_STEPS_HINT))).toBe(false);
    expect(order.find((line) => line.startsWith('stdout:'))).toContain('"report": "summary"');
  });
});

describe('runUsageReport default window hint', () => {
  it('tells daily users how to see older usage', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runUsageReport('daily', options));

    expect(order.at(-1)).toMatch(
      /Showing the last 7 days \(since \d{4}-\d{2}-\d{2}\)\. Use --since YYYY-MM-DD or --all/u,
    );
  });

  it('tells weekly users how to see older usage', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runUsageReport('weekly', options));

    expect(order.at(-1)).toMatch(
      /Showing the last 8 weeks \(since \d{4}-\d{2}-\d{2}\)\. Use --since YYYY-MM-DD or --all/u,
    );
  });

  it('prints no window hint for monthly', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runUsageReport('monthly', options));

    expect(order.some((line) => line.includes('Showing the last'))).toBe(false);
  });

  it('stays quiet once the user picks the range', async () => {
    const options = await emptySourceOptions();
    const order = await captureRun(() => runUsageReport('daily', { ...options, all: true }));

    expect(order.some((line) => line.includes('Showing the last 7 days'))).toBe(false);
  });

  describe('the ~ cost note', () => {
    async function runSummaryWithUnpricedEventDaysAgo(daysAgo: number): Promise<string[]> {
      const piDir = await mkdtemp(path.join(os.tmpdir(), 'summary-approximate-cost-'));
      tempDirs.push(piDir);
      const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
      const message = (timestamp: string, model: string, cost?: number) =>
        JSON.stringify({
          type: 'message',
          timestamp,
          provider: 'openai',
          model,
          usage: {
            input: 10,
            output: 5,
            totalTokens: 15,
            ...(cost === undefined ? {} : { cost: { total: cost } }),
          },
        });
      await writeFile(
        path.join(piDir, 'session.jsonl'),
        [
          JSON.stringify({ type: 'session', id: 'pi-approx', timestamp: at(daysAgo * 86_400_000) }),
          message(at(daysAgo * 86_400_000), 'mystery-model'),
          message(at(60_000), 'gpt-4.1', 1),
        ].join('\n'),
        'utf8',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network unavailable');
        }),
      );

      try {
        return await captureRun(() =>
          runSummaryReport({
            piDir,
            source: ['pi'],
            timezone: 'UTC',
            pricingUrl: 'https://example.test/summary-approximate-cost.json',
            ignorePricingFailures: true,
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it('explains ~ when an unpriced event falls in a shown window', async () => {
      const order = await runSummaryWithUnpricedEventDaysAgo(0);

      expect(order.some((line) => line.includes('~ marks costs'))).toBe(true);
    });

    it('stays silent when unpriced events only reach the activity grid', async () => {
      const order = await runSummaryWithUnpricedEventDaysAgo(60);

      expect(order.some((line) => line.includes('~ marks costs'))).toBe(false);
    });
  });
});
