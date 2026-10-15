import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildValueReportOutput } from '../../src/cli/run-value-report.js';
import type { ValueCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { ValueReportData } from '../../src/value/build-value-report.js';
import { freezeDate } from '../golden/golden-harness.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const deps = { createAdapters: createProjectFixtureAdapters };
const baseOptions = { timezone: 'UTC', pricingOffline: true } as const;

async function buildJson(
  options: ValueCommandOptions,
  overrideDeps: typeof deps = deps,
): Promise<ValueReportData> {
  const output = await buildValueReportOutput(
    { ...baseOptions, ...options, json: true },
    overrideDeps,
  );
  return (JSON.parse(output) as { data: ValueReportData }).data;
}

describe('value report', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('compares with claude-max-20x over claude usage when no plan is given', async () => {
    const data = await buildJson({});

    expect(data.plans.map((plan) => [plan.id, plan.priceUsdPerMonth, plan.sources])).toEqual([
      ['claude-max-20x', 200, ['claude']],
    ]);
    // Codex-only projects stay out.
    const projects = data.plans[0]?.months.flatMap((month) => month.projects) ?? [];
    expect(projects.map((project) => project.project)).not.toContain('tools');
  });

  it('carries the price date and the vendor pages', async () => {
    const data = await buildJson({ plan: ['chatgpt-plus'] });

    expect(data.asOf).toBe('2026-10-15');
    expect(data.plans[0]?.checkAt).toContain('https://chatgpt.com/pricing');
    expect(data.plans[0]?.references).toContain('https://www.morphllm.com/codex-pricing');
  });

  it('rejects --plan-price with several plans before reading usage', async () => {
    const createAdapters = vi.fn(createProjectFixtureAdapters);

    await expect(
      buildValueReportOutput(
        { ...baseOptions, plan: ['claude-pro', 'claude-max-5x'], planPrice: '50' },
        { createAdapters },
      ),
    ).rejects.toThrow('--plan-price sets the price of one plan');
    expect(createAdapters).not.toHaveBeenCalled();
  });

  it('rejects a --source that leaves a plan without sources, and an unknown --source', async () => {
    await expect(buildJson({ source: 'codex' })).rejects.toThrow(
      '--source leaves out every source of plan claude-max-20x (claude)',
    );
    await expect(buildJson({ source: 'claud' })).rejects.toThrow('Unknown --source value(s)');
  });

  it('covers the last N months with --last, counting the current one', async () => {
    const data = await buildJson({ last: '3' });

    expect(data.window).toEqual({ since: '2026-04-01', until: '2026-06-21' });
    expect(data.plans[0]?.months.map((month) => [month.month, month.totalTokens > 0])).toEqual([
      ['2026-04', false],
      ['2026-05', true],
      ['2026-06', true],
    ]);
    await expect(buildJson({ last: '3', all: true })).rejects.toThrow(
      '--last cannot be combined with --since, --until, or --all',
    );
  });

  it('marks costs incomplete with --cost-mode explicit when the sources log no cost', async () => {
    const data = await buildJson({ costMode: 'explicit', since: '2026-04-01' });
    const months = data.plans[0]?.months ?? [];

    expect(months.map((month) => [month.month, month.apiCostUsd, month.costIncomplete])).toEqual([
      ['2026-04', 0, false],
      ['2026-05', 0, true],
      ['2026-06', 0, true],
    ]);
  });

  it('shows ~ on costs that leave out unpriced events', async () => {
    const createAdapters = (): SourceAdapter[] => [
      {
        id: 'claude',
        discoverFiles: async () => ['/value-test/claude.jsonl'],
        read: readFrom(async () => [
          createUsageEvent({
            source: 'claude',
            sessionId: 's',
            timestamp: '2026-06-01T10:00:00.000Z',
            model: 'unknown-model-xyz',
            inputTokens: 10,
            outputTokens: 1,
          }),
        ]),
      },
    ];
    const output = await buildValueReportOutput(
      { ...baseOptions, markdown: true },
      { createAdapters },
    );

    expect(output).toContain('~$0.00');
    expect(output).toContain('~0.00x');
  });

  it('counts only the --repo projects', async () => {
    const data = await buildJson({ repo: 'api' });
    const projects = new Set(
      data.plans[0]?.months.flatMap((month) => month.projects.map((project) => project.project)),
    );

    expect([...projects].sort()).toEqual(['a/api', 'b/api']);
  });

  it('leaves cost out with --no-cost and abbreviates tokens with --compact', async () => {
    const noCost = await buildValueReportOutput(
      { ...baseOptions, markdown: true, cost: false },
      deps,
    );
    const compact = await buildValueReportOutput(
      { ...baseOptions, markdown: true, compact: true },
      deps,
    );

    expect(noCost).not.toContain('$');
    expect(noCost).toContain('Plan prices as of 2026-10-15');
    expect(compact).toContain('20.1K');
    expect(compact).not.toContain('Difference');
    await expect(
      buildValueReportOutput({ ...baseOptions, json: true, compact: true }, deps),
    ).rejects.toThrow('--compact applies to terminal and markdown tables');
    await expect(
      buildValueReportOutput({ ...baseOptions, json: true, cost: false }, deps),
    ).rejects.toThrow('--no-cost applies to tables');
  });

  it('says there is no usage instead of printing empty tables', async () => {
    const output = await buildValueReportOutput(
      { ...baseOptions, markdown: true, repo: 'no-such-project' },
      deps,
    );

    expect(output).toBe('No usage data found for the selected filters.');
  });
});
