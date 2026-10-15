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

export const SUBSCRIPTION_PLANS = [
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
