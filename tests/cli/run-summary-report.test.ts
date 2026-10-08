import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSummaryReport, SUMMARY_NEXT_STEPS_HINT } from '../../src/cli/run-summary-report.js';
import * as shareArtifact from '../../src/cli/share-artifact.js';
import { runUsageReport } from '../../src/cli/run-usage-report.js';

const tempDirs: string[] = [];

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

  it('writes the activity share card and page with --share', async () => {
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

    const svg = await readFile(path.join(shareDir, 'summary-share.svg'), 'utf8');
    const page = await readFile(path.join(shareDir, 'summary-share.html'), 'utf8');
    expect(svg).toContain('data-theme="dark"');
    expect(svg).toContain('No usage in the past year');
    expect(page).toContain('data-theme="light"');
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
});
