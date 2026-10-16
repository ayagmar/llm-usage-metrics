import { describe, expect, it } from 'vitest';

import { buildEventProjectLabels } from '../../src/aggregate/project-key.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  buildValueReport,
  resolvePlanScopes,
  type BuildValueReportOptions,
} from '../../src/value/build-value-report.js';
import { selectPlans } from '../../src/value/plans.js';

function claudeEvent(
  timestamp: string,
  costUsd: number | undefined,
  repoRoot?: string,
): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId: `s-${timestamp}`,
    timestamp,
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
  });
}

function build(
  events: UsageEvent[],
  options: Partial<BuildValueReportOptions> & { planIds?: string[] } = {},
) {
  const { planIds, ...rest } = options;

  return buildValueReport(events, {
    plans: resolvePlanScopes(selectPlans(planIds, undefined), undefined),
    timezone: 'UTC',
    today: '2026-06-21',
    projectLabels: buildEventProjectLabels(events),
    ...rest,
  });
}

describe('buildValueReport', () => {
  it('gives every month of the window a row, idle months at $0, and marks cut months partial', () => {
    const events = [claudeEvent('2026-02-10T10:00:00.000Z', 3, '/w/api')];
    const [plan] = build(events, { since: '2026-01-15', until: '2026-04-30' }).plans;

    expect(
      plan.months.map(({ month, partial, apiCostUsd }) => ({ month, partial, apiCostUsd })),
    ).toEqual([
      { month: '2026-01', partial: true, apiCostUsd: 0 },
      { month: '2026-02', partial: false, apiCostUsd: 3 },
      { month: '2026-03', partial: false, apiCostUsd: 0 },
      { month: '2026-04', partial: false, apiCostUsd: 0 },
    ]);
    expect(plan.total).toMatchObject({ apiCostUsd: 3, planPriceUsd: 800, differenceUsd: -797 });
  });

  it('starts full history on the 1st of the first month and ends at the current month, partial', () => {
    const report = build([claudeEvent('2026-04-20T10:00:00.000Z', 1)]);

    expect(report.window).toEqual({ since: '2026-04-01', until: '2026-06-21' });
    expect(report.plans[0].months.map(({ month, partial }) => [month, partial])).toEqual([
      ['2026-04', false],
      ['2026-05', false],
      ['2026-06', true],
    ]);
  });

  it('marks a month cut by --until partial', () => {
    const report = build([claudeEvent('2026-03-02T10:00:00.000Z', 1)], { until: '2026-03-20' });

    expect(report.plans[0].months.map(({ month, partial }) => [month, partial])).toEqual([
      ['2026-03', true],
    ]);
  });

  it('ends at the current month when an event is dated after today', () => {
    const [plan] = build([
      claudeEvent('2026-06-01T10:00:00.000Z', 1),
      claudeEvent('2026-07-01T10:00:00.000Z', 5),
    ]).plans;

    expect(plan.months.map(({ month, partial }) => [month, partial])).toEqual([['2026-06', true]]);
    expect(plan.total).toMatchObject({ apiCostUsd: 1, planPriceUsd: 200 });
  });

  it('stops at today when --until is in a later month or later this month', () => {
    const events = [claudeEvent('2026-05-02T10:00:00.000Z', 1)];

    for (const until of ['2026-08-31', '2026-06-30']) {
      const report = build(events, { until });

      expect(report.window).toEqual({ since: '2026-05-01', until: '2026-06-21' });
      expect(report.plans[0].months.map(({ month, partial }) => [month, partial])).toEqual([
        ['2026-05', false],
        ['2026-06', true],
      ]);
      expect(report.plans[0].total.planPriceUsd).toBe(400);
    }
  });

  it('buckets months in the report timezone', () => {
    const report = build([claudeEvent('2026-05-31T23:30:00.000Z', 2)], {
      timezone: 'Asia/Tokyo',
    });

    expect(report.plans[0].months[0]).toMatchObject({ month: '2026-06', apiCostUsd: 2 });
  });

  it('has no months without usage or --since', () => {
    const report = build([]);

    expect(report.window).toEqual({ since: null, until: '2026-06-21' });
    expect(report.plans[0].months).toEqual([]);
    expect(report.plans[0].total).toMatchObject({ ratio: null, planPriceUsd: 0 });
  });

  it('flags a month, its project and the total when an event has no cost', () => {
    const [plan] = build([
      claudeEvent('2026-06-01T10:00:00.000Z', 4, '/w/api'),
      claudeEvent('2026-06-02T10:00:00.000Z', undefined, '/w/api'),
    ]).plans;

    expect(plan.months[0]).toMatchObject({ apiCostUsd: 4, costIncomplete: true });
    expect(plan.months[0].projects[0]).toMatchObject({ costUsd: 4, costIncomplete: true });
    expect(plan.total.costIncomplete).toBe(true);
  });

  it('splits a month by project with shares of its cost, most expensive first', () => {
    const [plan] = build([
      claudeEvent('2026-06-01T10:00:00.000Z', 1, '/w/a/api'),
      claudeEvent('2026-06-02T10:00:00.000Z', 3, '/w/b/api'),
      claudeEvent('2026-06-03T10:00:00.000Z', 0),
    ]).plans;
    const projects = plan.months[0].projects;

    expect(projects.map(({ project, share }) => [project, share])).toEqual([
      ['b/api', 0.75],
      ['a/api', 0.25],
      ['(unattributed)', 0],
    ]);
    expect(projects.reduce((sum, project) => sum + (project.share ?? 0), 0)).toBeCloseTo(1, 9);
  });

  it('gives no share when the month cost nothing', () => {
    const [plan] = build([claudeEvent('2026-06-01T10:00:00.000Z', 0, '/w/api')]).plans;

    expect(plan.months[0].projects[0].share).toBeNull();
  });

  it('counts only the plan sources, and the full cost for each plan that covers a source', () => {
    const codex = createUsageEvent({
      source: 'codex',
      sessionId: 'codex',
      timestamp: '2026-06-01T10:00:00.000Z',
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 5,
    });
    const report = build([claudeEvent('2026-06-01T10:00:00.000Z', 2), codex], {
      planIds: ['claude-pro', 'claude-max-5x', 'chatgpt-plus'],
    });

    expect(report.plans.map((plan) => [plan.id, plan.total.apiCostUsd])).toEqual([
      ['claude-pro', 2],
      ['claude-max-5x', 2],
      ['chatgpt-plus', 5],
    ]);
  });
});

describe('resolvePlanScopes', () => {
  it('narrows plan sources by the source filter and rejects a plan left with none', () => {
    const plans = selectPlans(['claude-pro', 'chatgpt-plus'], undefined);

    expect(() => resolvePlanScopes(plans, new Set(['claude']))).toThrow(
      '--source leaves out every source of plan chatgpt-plus (codex)',
    );
    expect(resolvePlanScopes(plans.slice(0, 1), new Set(['claude', 'pi']))[0].sources).toEqual([
      'claude',
    ]);
  });
});
