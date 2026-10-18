import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildUsageData, findRepeatedLocalHours } from '../../src/cli/build-usage-data.js';
import { runHourlyReport } from '../../src/cli/run-hourly-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const NEW_YORK = 'America/New_York';

async function captureRun(run: () => Promise<void>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
    stderr.push(String(value));
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    stdout.push(String(value));
  });

  try {
    await run();
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function piMessage(timestamp: string, input: number): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    provider: 'openai',
    model: 'gpt-5',
    usage: { input, output: 10, totalTokens: input + 10 },
  });
}

describe('runHourlyReport', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  /** A pi directory with one session holding messages at the given timestamps. */
  async function writePiSession(name: string, timestamps: readonly string[]) {
    const piDir = path.join(environment.rootDir, name);
    const sessionFile = path.join(piDir, 'session.jsonl');
    await mkdir(piDir, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: 'session', id: name, timestamp: timestamps[0], cwd: '/w/repo' }),
        ...timestamps.map((timestamp, index) => piMessage(timestamp, 100 * (index + 1))),
      ].join('\n'),
    );
    // Later than every event, so the dated window does not skip the file.
    const mtime = new Date('2026-12-01T00:00:00.000Z');
    await utimes(sessionFile, mtime, mtime);
    return { piDir, source: 'pi', pricingOffline: true } as const;
  }

  it('reports today hour by hour without dates and says how to see earlier hours', async () => {
    const sourceOptions = await writePiSession('empty-today', ['2020-01-01T00:00:00.000Z']);
    const { stderr } = await captureRun(() =>
      runHourlyReport({ ...sourceOptions, timezone: 'UTC' }),
    );

    expect(stderr).toMatch(
      /Showing today \(\d{4}-\d{2}-\d{2}\) hour by hour\. Use --last N \(up to 31 days\) or --since YYYY-MM-DD/u,
    );
  });

  it('ends the default window today, so a future-dated event stays out', async () => {
    const sourceOptions = await writePiSession('future', [
      '2026-06-21T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z',
    ]);
    const data = await buildUsageData(
      'hourly',
      { ...sourceOptions, timezone: 'UTC' },
      { now: () => new Date('2026-06-21T12:00:00.000Z') },
    );

    expect(data.defaultWindowSince).toBe('2026-06-21');
    expect(
      data.rows.filter((row) => row.rowType === 'period_source').map((row) => row.periodKey),
    ).toEqual(['2026-06-21 10:00']);
  });

  it('reports every hour with --all, not only today', async () => {
    const sourceOptions = await writePiSession('all', [
      '2026-01-10T08:00:00.000Z',
      '2026-06-21T10:00:00.000Z',
    ]);
    const data = await buildUsageData(
      'hourly',
      { ...sourceOptions, timezone: 'UTC', all: true },
      { now: () => new Date('2026-06-21T12:00:00.000Z') },
    );

    expect(data.defaultWindowSince).toBeUndefined();
    expect(
      data.rows.filter((row) => row.rowType === 'period_source').map((row) => row.periodKey),
    ).toEqual(['2026-01-10 08:00', '2026-06-21 10:00']);
  });

  it('merges both occurrences of a fall-back hour under one key and notes it', async () => {
    const sourceOptions = await writePiSession('fall-back', [
      // 01:30 EDT, then 01:30 EST an hour later, then 02:10 EST.
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:10:00.000Z',
    ]);
    const { stdout, stderr } = await captureRun(() =>
      runHourlyReport({
        ...sourceOptions,
        timezone: NEW_YORK,
        since: '2026-11-01',
        until: '2026-11-01',
        json: true,
      }),
    );
    const rows = (
      JSON.parse(stdout) as {
        data: { rowType: string; periodKey: string; inputTokens: number; repeatedHour?: true }[];
      }
    ).data.filter((row) => row.rowType === 'period_source');

    expect(rows.map((row) => [row.periodKey, row.inputTokens, row.repeatedHour])).toEqual([
      ['2026-11-01 01:00', 300, true],
      ['2026-11-01 02:00', 300, undefined],
    ]);
    expect(stderr).toContain(
      '2026-11-01 01:00 repeats: the clocks went back at the end of daylight saving time, so its row covers both occurrences.',
    );
    expect(stderr).not.toContain('two hours');
  });

  it('rejects --last outside 1-31 days and with dates', async () => {
    const sourceOptions = await writePiSession('last', ['2026-06-15T10:00:00.000Z']);

    for (const last of ['0', '32', '1.5']) {
      await expect(runHourlyReport({ ...sourceOptions, last })).rejects.toThrow(
        '--last must be a whole number from 1 to 31',
      );
    }

    await expect(
      runHourlyReport({ ...sourceOptions, last: '2', since: '2026-06-15' }),
    ).rejects.toThrow('--last cannot be combined with --since, --until, or --all');
    await expect(runHourlyReport({ ...sourceOptions, last: '2', all: true })).rejects.toThrow(
      '--last cannot be combined with --since, --until, or --all',
    );
  });
});

describe('findRepeatedLocalHours', () => {
  it('names only hours whose events fall on both sides of a fall-back', () => {
    const firstOccurrenceOnly = [
      { timestamp: '2026-11-01T05:10:00.000Z' },
      { timestamp: '2026-11-01T05:50:00.000Z' },
    ];

    expect(findRepeatedLocalHours(firstOccurrenceOnly, NEW_YORK)).toEqual([]);
    expect(
      findRepeatedLocalHours(
        [...firstOccurrenceOnly, { timestamp: '2026-11-01T06:05:00.000Z' }],
        NEW_YORK,
      ),
    ).toEqual(['2026-11-01 01:00']);
    // Lord Howe falls back 30 minutes: 01:30-02:00 repeats inside the 01:00 key.
    expect(
      findRepeatedLocalHours(
        [{ timestamp: '2026-04-04T14:45:00.000Z' }, { timestamp: '2026-04-04T15:15:00.000Z' }],
        'Australia/Lord_Howe',
      ),
    ).toEqual(['2026-04-05 01:00']);
    expect(findRepeatedLocalHours([{ timestamp: '2026-06-15T10:00:00.000Z' }], 'UTC')).toEqual([]);
  });
});
