/**
 * Subscription plans the value report compares API-priced usage against. Prices are USD per
 * month, excluding tax, as listed on `asOf`; check them at `checkAt` before relying on them.
 */
export const PLANS_AS_OF = '2026-10-15';

export type PlanVendor = {
  /** Vendor pages that list the current prices. */
  checkAt: readonly string[];
  /** The third-party summaries the prices were taken from. */
  references: readonly string[];
};

const CLAUDE_VENDOR: PlanVendor = {
  checkAt: ['https://claude.com/pricing'],
  references: [
    'https://www.morphllm.com/claude-code-pricing',
    'https://www.wearetandem.ai/en/blog/tools/claude-max-pro-pricing-plans',
  ],
};

const OPENAI_VENDOR: PlanVendor = {
  checkAt: ['https://chatgpt.com/pricing', 'https://developers.openai.com/codex/pricing'],
  references: ['https://www.morphllm.com/codex-pricing'],
};

export type SubscriptionPlan = {
  id: string;
  priceUsdPerMonth: number;
  /** Source ids whose usage the plan covers. */
  sources: readonly string[];
  vendor: PlanVendor;
};

const SUBSCRIPTION_PLANS = [
  { id: 'claude-pro', priceUsdPerMonth: 20, sources: ['claude'], vendor: CLAUDE_VENDOR },
  { id: 'claude-max-5x', priceUsdPerMonth: 100, sources: ['claude'], vendor: CLAUDE_VENDOR },
  { id: 'claude-max-20x', priceUsdPerMonth: 200, sources: ['claude'], vendor: CLAUDE_VENDOR },
  { id: 'chatgpt-go', priceUsdPerMonth: 8, sources: ['codex'], vendor: OPENAI_VENDOR },
  { id: 'chatgpt-plus', priceUsdPerMonth: 20, sources: ['codex'], vendor: OPENAI_VENDOR },
  { id: 'chatgpt-pro-100', priceUsdPerMonth: 100, sources: ['codex'], vendor: OPENAI_VENDOR },
  { id: 'chatgpt-pro-200', priceUsdPerMonth: 200, sources: ['codex'], vendor: OPENAI_VENDOR },
  { id: 'chatgpt-pro-500', priceUsdPerMonth: 500, sources: ['codex'], vendor: OPENAI_VENDOR },
] as const satisfies readonly SubscriptionPlan[];

export type PlanId = (typeof SUBSCRIPTION_PLANS)[number]['id'];

export const PLAN_IDS: readonly PlanId[] = SUBSCRIPTION_PLANS.map((plan) => plan.id);

export const DEFAULT_PLAN_ID: PlanId = 'claude-max-20x';

/** The default plan when the source filter leaves out every source of `DEFAULT_PLAN_ID`. */
export const FALLBACK_PLAN_ID: PlanId = 'chatgpt-pro-200';

/**
 * The default plan without `--plan`, in order of preference: the first one whose sources
 * the source filter keeps, so a filter that leaves out claude still gets a report.
 */
const DEFAULT_PLAN_IDS: readonly PlanId[] = [DEFAULT_PLAN_ID, FALLBACK_PLAN_ID];

/** A plan the report compares against, with the monthly price it uses. */
export type SelectedPlan = {
  plan: SubscriptionPlan;
  priceUsdPerMonth: number;
  /** `override` when `--plan-price` replaced the list price. */
  priceSource: 'list' | 'override';
};

function findPlan(id: string): SubscriptionPlan {
  const plan = SUBSCRIPTION_PLANS.find((candidate) => candidate.id === id);

  if (!plan) {
    throw new Error(`Unknown --plan value: ${id}. Allowed values: ${PLAN_IDS.join(', ')}`);
  }

  return plan;
}

function parsePlanPrice(planPrice: string): number {
  const normalized = planPrice.trim();
  const price = Number(normalized);

  if (!/^\d+(?:\.\d+)?$/u.test(normalized) || !Number.isFinite(price) || price <= 0) {
    throw new Error('--plan-price must be a positive amount in USD, such as 18 or 17.50');
  }

  return price;
}

function findDefaultPlanId(
  sourceFilter: ReadonlySet<string> | undefined,
  sourceFilterLabel: string,
): PlanId {
  const id = DEFAULT_PLAN_IDS.find((candidate) =>
    findPlan(candidate).sources.some((source) => !sourceFilter || sourceFilter.has(source)),
  );

  if (id === undefined) {
    const planSources = [...new Set(SUBSCRIPTION_PLANS.flatMap((plan) => plan.sources))];

    throw new Error(
      `No plan covers ${sourceFilterLabel} (${[...(sourceFilter ?? [])].join(', ')}); plans cover ${planSources.join(', ')}. Pass --plan <id> and keep its sources in ${sourceFilterLabel}`,
    );
  }

  return id;
}

/**
 * The stderr note when no `--plan` is given and the default falls back from
 * `DEFAULT_PLAN_ID`, which the help names as the default; otherwise `undefined`.
 */
export function describeDefaultPlanFallback(
  planIds: readonly string[] | undefined,
  selected: readonly SelectedPlan[],
  sourceFilterLabel = '--source',
): string | undefined {
  const [chosen] = selected;

  if ((planIds && planIds.length > 0) || chosen.plan.id === DEFAULT_PLAN_ID) {
    return undefined;
  }

  const defaultPlan = findPlan(DEFAULT_PLAN_ID);

  return `no --plan given; comparing with ${chosen.plan.id}, since ${sourceFilterLabel} leaves out every source of ${DEFAULT_PLAN_ID} (${defaultPlan.sources.join(', ')})`;
}

/**
 * The plans `--plan` names, in order and without repeats. Without `--plan`, the first
 * default plan whose sources the source filter (`--source` or config `sources`) keeps.
 * `--plan-price` replaces the list price and needs exactly one plan, the default counting
 * as one.
 */
export function selectPlans(
  planIds: readonly string[] | undefined,
  planPrice: string | undefined,
  sourceFilter?: ReadonlySet<string>,
  sourceFilterLabel = '--source',
): SelectedPlan[] {
  const requested =
    planIds && planIds.length > 0 ? planIds : [findDefaultPlanId(sourceFilter, sourceFilterLabel)];
  const ids = [...new Set(requested.map((id) => id.trim()))];
  const plans = ids.map((id) => findPlan(id));

  if (planPrice === undefined) {
    return plans.map((plan) => ({
      plan,
      priceUsdPerMonth: plan.priceUsdPerMonth,
      priceSource: 'list',
    }));
  }

  if (plans.length !== 1) {
    throw new Error(
      `--plan-price sets the price of one plan; pass a single --plan (got ${ids.join(', ')})`,
    );
  }

  return [{ plan: plans[0], priceUsdPerMonth: parsePlanPrice(planPrice), priceSource: 'override' }];
}
