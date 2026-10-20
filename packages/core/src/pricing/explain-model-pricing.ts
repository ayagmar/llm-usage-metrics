import type {
  CanonicalModelKeyRule,
  ModelPricing,
  PricingDataOrigin,
  PricingOverrideMatch,
  PricingSource,
  PriorityFallbackBucket,
  ReasoningBillingMode,
} from './types.js';

/** Rates per 1M tokens in USD; `null` where the pricing has no rate. */
export type ExplainedRates = {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cacheReadPer1MUsd: number | null;
  cacheWritePer1MUsd: number | null;
  /** Without it, one-hour cache writes bill at `cacheWritePer1MUsd`. */
  cacheWrite1hPer1MUsd: number | null;
  reasoningPer1MUsd: number | null;
  reasoningBilling: ReasoningBillingMode;
};

/** Rates for a request whose prompt is strictly above `aboveTokens`; `null` keeps the base rate. */
export type ExplainedTier = {
  aboveTokens: number;
  inputPer1MUsd: number | null;
  outputPer1MUsd: number | null;
  cacheReadPer1MUsd: number | null;
  cacheWritePer1MUsd: number | null;
  cacheWrite1hPer1MUsd: number | null;
};

/** One model name's prices and how they were found, as `llm-usage pricing --json` prints them. */
export type ExplainedModelPricing = {
  /** The name as given. */
  model: string;
  normalizedModel: string;
  /** The key whose prices apply; `null` when the name is unpriced. */
  pricingKey: string | null;
  rule: CanonicalModelKeyRule | null;
  canonicalModel: string | null;
  strippedModel: string | null;
  fuzzyDistance: number | null;
  override: PricingOverrideMatch;
  origin: { kind: PricingDataOrigin['kind']; fetchedAt: string; url: string } | null;
  retired: boolean;
  rates: ExplainedRates | null;
  tiers: ExplainedTier[];
  priorityFallback: PriorityFallbackBucket[];
};

export type PricingReportData = {
  models: ExplainedModelPricing[];
};

function toRates(pricing: ModelPricing): ExplainedRates {
  return {
    inputPer1MUsd: pricing.inputPer1MUsd,
    outputPer1MUsd: pricing.outputPer1MUsd,
    cacheReadPer1MUsd: pricing.cacheReadPer1MUsd ?? null,
    cacheWritePer1MUsd: pricing.cacheWritePer1MUsd ?? null,
    cacheWrite1hPer1MUsd: pricing.cacheWrite1hPer1MUsd ?? null,
    reasoningPer1MUsd: pricing.reasoningPer1MUsd ?? null,
    // The cost engine's default.
    reasoningBilling: pricing.reasoningBilling ?? 'included-in-output',
  };
}

function toTiers(pricing: ModelPricing | undefined): ExplainedTier[] {
  return (pricing?.tiers ?? []).map((tier) => ({
    aboveTokens: tier.aboveTokens,
    inputPer1MUsd: tier.inputPer1MUsd ?? null,
    outputPer1MUsd: tier.outputPer1MUsd ?? null,
    cacheReadPer1MUsd: tier.cacheReadPer1MUsd ?? null,
    cacheWritePer1MUsd: tier.cacheWritePer1MUsd ?? null,
    cacheWrite1hPer1MUsd: tier.cacheWrite1hPer1MUsd ?? null,
  }));
}

/** Explains one name through `source`, the same source the cost engine prices events with. */
export function explainModelPricing(source: PricingSource, model: string): ExplainedModelPricing {
  if (!source.explainModel) {
    throw new Error('This pricing source cannot explain its prices');
  }

  const explanation = source.explainModel(model);
  const { match, origin, pricing } = explanation;

  return {
    model,
    normalizedModel: explanation.normalizedModel,
    pricingKey: pricing ? explanation.resolvedModel : null,
    rule: match?.rule ?? null,
    canonicalModel: match?.canonicalModel ?? null,
    strippedModel: match?.strippedModel ?? null,
    fuzzyDistance: match?.fuzzyDistance ?? null,
    override: explanation.override,
    origin: origin
      ? { kind: origin.kind, fetchedAt: new Date(origin.fetchedAt).toISOString(), url: origin.url }
      : null,
    retired: explanation.retired,
    rates: pricing ? toRates(pricing) : null,
    tiers: toTiers(pricing),
    priorityFallback: [...(pricing?.priorityFallback ?? [])],
  };
}
