import { describe, expect, it } from 'vitest';

import { DEFAULT_PLAN_ID, PLAN_IDS, selectPlans } from '../../src/value/plans.js';

describe('selectPlans', () => {
  it('uses the default plan at its list price when no plan is named', () => {
    const plans = selectPlans(undefined, undefined);

    expect(
      plans.map(({ plan, priceUsdPerMonth, priceSource }) => [
        plan.id,
        priceUsdPerMonth,
        priceSource,
      ]),
    ).toEqual([[DEFAULT_PLAN_ID, 200, 'list']]);
  });

  it('defaults to the first default plan whose sources the source filter keeps', () => {
    const ids = (filter?: ReadonlySet<string>) =>
      selectPlans(undefined, undefined, filter).map((selected) => selected.plan.id);

    expect(ids(new Set(['claude', 'codex']))).toEqual([DEFAULT_PLAN_ID]);
    expect(ids(new Set(['codex', 'pi']))).toEqual(['chatgpt-pro-200']);
    expect(() => selectPlans(undefined, undefined, new Set(['pi']), 'config `sources`')).toThrow(
      'No plan covers config `sources` (pi); plans cover claude, codex. Pass --plan <id> and keep its sources in config `sources`',
    );
    // A named plan is kept as given; resolvePlanScopes rejects it if the filter drops it.
    expect(
      selectPlans(['claude-pro'], undefined, new Set(['codex'])).map(({ plan }) => plan.id),
    ).toEqual(['claude-pro']);
  });

  it('keeps --plan order and drops repeats', () => {
    const plans = selectPlans(['chatgpt-plus', 'claude-pro', ' chatgpt-plus'], undefined);

    expect(plans.map((selected) => selected.plan.id)).toEqual(['chatgpt-plus', 'claude-pro']);
    expect(plans.map((selected) => selected.plan.sources)).toEqual([['codex'], ['claude']]);
  });

  it('names every plan id when one is unknown', () => {
    expect(() => selectPlans(['claude-ultra'], undefined)).toThrow(
      `Unknown --plan value: claude-ultra. Allowed values: ${PLAN_IDS.join(', ')}`,
    );
  });

  it('applies --plan-price to the one plan, the default included', () => {
    const plans = selectPlans(undefined, '17.50');

    expect(
      plans.map(({ plan, priceUsdPerMonth, priceSource }) => [
        plan.id,
        priceUsdPerMonth,
        priceSource,
      ]),
    ).toEqual([[DEFAULT_PLAN_ID, 17.5, 'override']]);
    expect(selectPlans(['claude-pro', 'claude-pro'], '18')[0].priceUsdPerMonth).toBe(18);
  });

  it('rejects --plan-price with several plans', () => {
    expect(() => selectPlans(['claude-pro', 'chatgpt-plus'], '18')).toThrow(
      '--plan-price sets the price of one plan; pass a single --plan (got claude-pro, chatgpt-plus)',
    );
  });

  it.each(['0', '-5', 'abc', '', '1e3', 'Infinity'])('rejects --plan-price %j', (price) => {
    expect(() => selectPlans(undefined, price)).toThrow('--plan-price must be a positive amount');
  });
});
