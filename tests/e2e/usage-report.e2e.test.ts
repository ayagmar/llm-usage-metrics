import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');

describe('usage report e2e', () => {
  it('renders daily report with mixed pi + codex data', async () => {
    const report = await buildUsageReport('daily', {
      piDir,
      codexDir,
      source: 'pi,codex',
      timezone: 'UTC',
    });

    expect(report).toContain('2026-01-04');
    expect(report).toContain('2026-01-05');
    expect(report).toContain('2026-02-01');
    expect(report).toContain('2026-02-02');
    expect(report).toContain('pi');
    expect(report).toContain('codex');
    expect(report).toContain('TOTAL');
  });

  it('renders weekly report with Monday-based week buckets', async () => {
    const report = await buildUsageReport('weekly', {
      piDir,
      codexDir,
      source: 'pi,codex',
      timezone: 'UTC',
      markdown: true,
    });

    expect(report).toContain('2026-W01');
    expect(report).toContain('2026-W02');
    expect(report).toContain('2026-W05');
    expect(report).toContain('2026-W06');
  });

  it('renders monthly report with combined totals', async () => {
    const report = await buildUsageReport('monthly', {
      piDir,
      codexDir,
      source: 'pi,codex',
      timezone: 'UTC',
      json: true,
    });

    const rows = JSON.parse(report) as { periodKey: string; rowType: string }[];

    expect(rows.some((row) => row.periodKey === '2026-01')).toBe(true);
    expect(rows.some((row) => row.periodKey === '2026-02')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ periodKey: 'ALL', rowType: 'grand_total' });
  });

  it('renders daily report from openclaw source-dir override', async () => {
    const report = await buildUsageReport('daily', {
      source: 'openclaw',
      sourceDir: [`openclaw=${openclawDir}`],
      timezone: 'UTC',
    });

    expect(report).toContain('2026-05-01');
    expect(report).toContain('openclaw');
    expect(report).toContain('TOTAL');
  });
});
