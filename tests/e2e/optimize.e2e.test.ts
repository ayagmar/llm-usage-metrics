import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOptimizeReport } from '../../src/cli/run-optimize-report.js';
import type { OptimizeCandidateRow, OptimizeRow } from '../../src/optimize/optimize-row.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');

describe('optimize report e2e', () => {
  it('renders deterministic missing-pricing JSON over real usage fixtures', async () => {
    const report = await buildOptimizeReport('monthly', {
      piDir,
      codexDir,
      source: 'pi,codex',
      provider: 'openai',
      timezone: 'UTC',
      since: '2026-01-01',
      until: '2026-02-28',
      candidateModel: ['definitely-missing-model'],
      top: '1',
      json: true,
      ignorePricingFailures: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: OptimizeRow[];
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'optimize' });
    const rows = parsed.data;
    const candidateRows = rows.filter(
      (row): row is OptimizeCandidateRow => row.rowType === 'candidate',
    );

    expect(rows.some((row) => row.rowType === 'baseline' && row.periodKey === 'ALL')).toBe(true);
    expect(candidateRows.map((row) => row.periodKey)).toEqual(['2026-01', '2026-02', 'ALL']);
    expect(candidateRows.every((row) => row.candidateModel === 'definitely-missing-model')).toBe(
      true,
    );
    expect(candidateRows.every((row) => row.hypotheticalCostIncomplete)).toBe(true);
    expect(candidateRows.every((row) => row.notes?.includes('missing_pricing'))).toBe(true);
    expect(candidateRows.find((row) => row.periodKey === 'ALL')?.totalTokens).toBeGreaterThan(0);
  });
});
