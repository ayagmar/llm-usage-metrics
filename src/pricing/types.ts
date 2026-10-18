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

export type PriorityFallbackBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export type ModelPricing = {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cacheReadPer1MUsd?: number;
  cacheWritePer1MUsd?: number;
  /** One-hour cache writes; without it they bill at `cacheWritePer1MUsd`. */
  cacheWrite1hPer1MUsd?: number;
  reasoningPer1MUsd?: number;
  reasoningBilling?: ReasoningBillingMode;
  /** Buckets LiteLLM lists no standard rate for, so their priority rate stands in. */
  priorityFallback?: PriorityFallbackBucket[];
  /** Long-context rates, highest `aboveTokens` first. They apply per request only. */
  tiers?: PricingTier[];
};

export interface PricingSource {
  resolveModelAlias(model: string): string;
  getPricing(model: string): ModelPricing | undefined;
  /** LiteLLM's `max_input_tokens` for the model's key; undefined when it lists none. */
  getMaxInputTokens?(model: string): number | undefined;
  /** Explains `getPricing(resolveModelAlias(model))`; reports call the two directly. */
  explainModel?(model: string): ModelPricingExplanation;
}

/**
 * How the matcher found a pricing key: `direct` (the name, or the name without its provider
 * prefix, is a key), `effort-suffix` (the name without a reasoning-effort suffix is a key),
 * `provider-prefixed` (a key is the name behind a provider prefix), `release-suffix` (the
 * name is a key followed by a date, version or effort suffix), `fuzzy` (closest key by edit
 * distance), or `preferred-key` (the model map names the key for the canonical model).
 */
export type CanonicalModelKeyRule =
  'preferred-key' | 'direct' | 'effort-suffix' | 'provider-prefixed' | 'release-suffix' | 'fuzzy';

export type CanonicalModelKeyExplanation = {
  key: string;
  rule: CanonicalModelKeyRule;
  /** Set when the model map turned the name into this model, which the rule then matched. */
  canonicalModel?: string;
  /** The form that matched when the rule dropped a provider prefix or an effort suffix. */
  strippedModel?: string;
  /** Edit distance between the canonicalized name and key, for `fuzzy`. */
  fuzzyDistance?: number;
};

/** Where the LiteLLM prices came from: the cache file, a fetch, or the snapshot in the package. */
export type PricingDataOrigin = {
  kind: 'cache' | 'network' | 'bundled-snapshot';
  /** When the prices were fetched (ms since the epoch). */
  fetchedAt: number;
  url: string;
};

/** Whether a pricing override applied: keyed on the name itself, on its resolved key, or not. */
export type PricingOverrideMatch = 'raw' | 'resolved' | 'none';

/** What `getPricing(resolveModelAlias(model))` returns for one name, and why. */
export type ModelPricingExplanation = {
  /** The name as the matcher sees it (trimmed, lowercased). */
  normalizedModel: string;
  /** What `resolveModelAlias` returned. */
  resolvedModel: string;
  /** How the matcher found the key; absent when no key matched or an override keyed on the name won. */
  match?: CanonicalModelKeyExplanation;
  override: PricingOverrideMatch;
  /** Where the LiteLLM prices came from; absent when an override priced the name. */
  origin?: PricingDataOrigin;
  /** The key is a retired model back-filled from the bundled retired prices. */
  retired: boolean;
  /** The pricing the cost engine applies; absent when the name is unpriced. */
  pricing?: ModelPricing;
};
