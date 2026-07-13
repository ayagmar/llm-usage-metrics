import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';

type CompareJsonEnvelope = {
  schemaVersion: number;
  report: string;
  data: CompareJsonReport;
};

type CompareJsonReport = {
  current: {
    window: {
      since: string;
      until: string;
      label: string;
    };
    totals: {
      totalTokens: number;
      events: number;
      activeDays: number;
    };
  };
  baseline: {
    window: {
      since: string;
      until: string;
      label: string;
    };
    totals: {
      totalTokens: number;
      events: number;
      activeDays: number;
    };
  };
  totals: Array<{
    key: string;
    current: number;
    baseline: number;
    delta: number;
  }>;
};

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const selectedSources = 'pi,codex,gemini,droid,openclaw,claude';

function createCompareOptions() {
  return {
    source: selectedSources,
    piDir,
    codexDir,
    geminiDir,
    droidDir,
    openclawDir,
    claudeDir,
    since: '2026-06-01',
    until: '2026-06-30',
    vsSince: '2026-01-01',
    vsUntil: '2026-01-31',
    timezone: 'UTC',
    json: true,
    pricingOffline: true,
  };
}

describe('compare report e2e', () => {
  it('compares explicit fixture windows', async () => {
    const report = await buildCompareReport(createCompareOptions());
    const parsedEnvelope = JSON.parse(report) as CompareJsonEnvelope;

    expect(parsedEnvelope).toMatchObject({ schemaVersion: 1, report: 'compare' });
    const parsedReport = parsedEnvelope.data;

    expect(parsedReport.current.window).toEqual({
      since: '2026-06-01',
      until: '2026-06-30',
      label: '2026-06',
    });
    expect(parsedReport.baseline.window).toEqual({
      since: '2026-01-01',
      until: '2026-01-31',
      label: '2026-01',
    });

    // Fixture totals for selected sources:
    // June = gemini 195 + droid 200 + claude 220; January = pi 150 + codex 300.
    expect(parsedReport.current.totals).toMatchObject({
      totalTokens: 615,
      events: 6,
      activeDays: 4,
    });
    expect(parsedReport.baseline.totals).toMatchObject({
      totalTokens: 450,
      events: 2,
      activeDays: 2,
    });

    const totalTokensRow = parsedReport.totals.find((row) => row.key === 'totalTokens');

    expect(totalTokensRow).toMatchObject({
      current: 615,
      baseline: 450,
      delta: 165,
    });
  });

  it('rejects a one-sided baseline window', async () => {
    await expect(
      buildCompareReport({
        ...createCompareOptions(),
        vsUntil: undefined,
      }),
    ).rejects.toThrow('--vs-since and --vs-until must be provided together');
  });
});
