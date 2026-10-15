export type ReasoningBillingMode = 'included-in-output' | 'separate';

/**
 * Rates for a request whose prompt (input, cache read and cache write tokens) is strictly
 * above `aboveTokens`. A bucket without a rate here bills at the model's base rate.
 */
export type PricingTier = {
  aboveTokens: number;
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
  cacheReadPer1MUsd?: number;
  cacheWritePer1MUsd?: number;
  cacheWrite1hPer1MUsd?: number;
};

export type ModelPricing = {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cacheReadPer1MUsd?: number;
  cacheWritePer1MUsd?: number;
  /** One-hour cache writes; without it they bill at `cacheWritePer1MUsd`. */
  cacheWrite1hPer1MUsd?: number;
  reasoningPer1MUsd?: number;
  reasoningBilling?: ReasoningBillingMode;
  /** LiteLLM lists no standard rate for some bucket, so its priority rate stands in. */
  priorityFallback?: true;
  /** Long-context rates, highest `aboveTokens` first. They apply per request only. */
  tiers?: PricingTier[];
};

export interface PricingSource {
  resolveModelAlias(model: string): string;
  getPricing(model: string): ModelPricing | undefined;
}
