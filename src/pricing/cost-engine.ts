import {
  isPriceableEvent,
  type BillableTokenUsage,
  type UsageEvent,
} from '../domain/usage-event.js';
import type { ModelPricing, PriorityFallbackBucket, PricingSource, PricingTier } from './types.js';

const ONE_MILLION = 1_000_000;

/**
 * Which cost an event reports: `both` keeps a logged cost and estimates the rest, `explicit`
 * uses logged costs only, and `estimated` prices every event from its tokens.
 */
export type PricingCostMode = 'both' | 'explicit' | 'estimated';

/** How a pricing run prices events. */
export type PricingPolicy = {
  costMode: PricingCostMode;
  /** Sources whose events each record a single model request, so per-request rates apply. */
  perRequestSourceIds: ReadonlySet<string>;
};

/**
 * Priced events a run treated specially, keyed by the priced event's identity so the events
 * themselves carry nothing extra.
 */
export type PricingRunStats = {
  /** Events that logged $0 with tokens and were estimated instead. */
  reestimatedExplicitZero: WeakSet<UsageEvent>;
  /** Events priced at a model's priority rates because it lists no standard rate. */
  priorityPriced: WeakSet<UsageEvent>;
};

export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  costMode: 'both',
  perRequestSourceIds: new Set(),
};

export function createPricingRunStats(): PricingRunStats {
  return { reestimatedExplicitZero: new WeakSet(), priorityPriced: new WeakSet() };
}

/** One pricing run: the policy it applies and the stats it records. */
export type PricingRun = {
  policy: PricingPolicy;
  stats: PricingRunStats;
};

function estimateTokenGroupCost(tokens: number, per1MUsd: number | undefined): number {
  if (!per1MUsd || tokens <= 0) {
    return 0;
  }

  return (tokens / ONE_MILLION) * per1MUsd;
}

type BilledOutputTokens = {
  /** Output tokens billed at the output rate. */
  outputTokens: number;
  /** Reasoning tokens billed at the reasoning rate (0 when reasoning is included in output). */
  reasoningTokens: number;
};

/**
 * `outputTokens` already includes reasoning, so a model with a separate reasoning rate bills
 * only the non-reasoning remainder at the output rate and the reasoning share at its own rate.
 */
function splitOutputForBilling(
  usage: BillableTokenUsage,
  pricing: ModelPricing,
): BilledOutputTokens {
  if ((pricing.reasoningBilling ?? 'included-in-output') !== 'separate') {
    return { outputTokens: usage.outputTokens, reasoningTokens: 0 };
  }

  return {
    outputTokens: Math.max(0, usage.outputTokens - usage.reasoningTokens),
    reasoningTokens: usage.reasoningTokens,
  };
}

export function calculateEstimatedCostUsd(event: UsageEvent, pricing: ModelPricing): number {
  const billedOutput = splitOutputForBilling(event, pricing);

  const inputCost = estimateTokenGroupCost(event.inputTokens, pricing.inputPer1MUsd);
  const outputCost = estimateTokenGroupCost(billedOutput.outputTokens, pricing.outputPer1MUsd);
  const cacheReadCost = estimateTokenGroupCost(event.cacheReadTokens, pricing.cacheReadPer1MUsd);
  const cacheWriteCost =
    estimateTokenGroupCost(
      event.cacheWriteTokens - event.cacheWrite1hTokens,
      pricing.cacheWritePer1MUsd,
    ) +
    estimateTokenGroupCost(
      event.cacheWrite1hTokens,
      pricing.cacheWrite1hPer1MUsd ?? pricing.cacheWritePer1MUsd,
    );
  const reasoningCost = estimateTokenGroupCost(
    billedOutput.reasoningTokens,
    pricing.reasoningPer1MUsd,
  );

  return inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost;
}

/** Flat rates per tier, so pricing an event above a threshold allocates nothing new. */
const flatRatesByTier = new WeakMap<ModelPricing, WeakMap<PricingTier, ModelPricing>>();

function toFlatTierRates(pricing: ModelPricing, tier: PricingTier): ModelPricing {
  let ratesByTier = flatRatesByTier.get(pricing);

  if (!ratesByTier) {
    ratesByTier = new WeakMap();
    flatRatesByTier.set(pricing, ratesByTier);
  }

  let rates = ratesByTier.get(tier);

  if (!rates) {
    rates = {
      ...pricing,
      inputPer1MUsd: tier.inputPer1MUsd ?? pricing.inputPer1MUsd,
      outputPer1MUsd: tier.outputPer1MUsd ?? pricing.outputPer1MUsd,
      cacheReadPer1MUsd: tier.cacheReadPer1MUsd ?? pricing.cacheReadPer1MUsd,
      cacheWritePer1MUsd: tier.cacheWritePer1MUsd ?? pricing.cacheWritePer1MUsd,
      cacheWrite1hPer1MUsd: tier.cacheWrite1hPer1MUsd ?? pricing.cacheWrite1hPer1MUsd,
    };
    delete rates.tiers;
    ratesByTier.set(tier, rates);
  }

  return rates;
}

/**
 * The flat rates for one event. A per-request event (`perRequest`) whose prompt (input,
 * cache read and cache write tokens) is strictly above a tier's threshold bills at the
 * highest such tier; any other event bills at the base rates. Events from sources that sum
 * several requests must not cross a threshold on their totals, hence the gate.
 */
export function resolveRatesForEvent(
  event: BillableTokenUsage,
  pricing: ModelPricing,
  perRequest: boolean,
): ModelPricing {
  if (!perRequest || !pricing.tiers) {
    return pricing;
  }

  const promptTokens = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
  const tier = pricing.tiers.find((candidate) => promptTokens > candidate.aboveTokens);

  return tier ? toFlatTierRates(pricing, tier) : pricing;
}

function hasNonReasoningPricedBuckets(usage: BillableTokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0
  );
}

function hasDefinedRate(rate: number | undefined): boolean {
  return rate !== undefined;
}

export function hasUsedBucketWithUndefinedRate(
  usage: BillableTokenUsage,
  pricing: ModelPricing,
): boolean {
  if (usage.inputTokens > 0 && !hasDefinedRate(pricing.inputPer1MUsd)) {
    return true;
  }

  const billedOutput = splitOutputForBilling(usage, pricing);

  if (billedOutput.outputTokens > 0 && !hasDefinedRate(pricing.outputPer1MUsd)) {
    return true;
  }

  if (usage.cacheReadTokens > 0 && !hasDefinedRate(pricing.cacheReadPer1MUsd)) {
    return true;
  }

  if (usage.cacheWriteTokens > 0 && !hasDefinedRate(pricing.cacheWritePer1MUsd)) {
    return true;
  }

  return billedOutput.reasoningTokens > 0 && !hasDefinedRate(pricing.reasoningPer1MUsd);
}

export function canEstimateUsageCost(usage: BillableTokenUsage, pricing: ModelPricing): boolean {
  if (hasUsedBucketWithUndefinedRate(usage, pricing)) {
    return false;
  }

  const reasoningBilling = pricing.reasoningBilling ?? 'included-in-output';

  if (usage.reasoningTokens > 0) {
    if (reasoningBilling === 'separate') {
      return true;
    }

    if (usage.outputTokens === 0) {
      return false;
    }
  }

  return hasNonReasoningPricedBuckets(usage);
}

/** The event with no cost: reports leave it out of cost totals and mark them with `~`. */
function withoutCost(event: UsageEvent): UsageEvent {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { costUsd, ...unpricedEvent } = event;
  return { ...unpricedEvent, costMode: 'estimated' };
}

function applyResolvedPricingToEvent(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
  run: PricingRun,
): UsageEvent {
  if (run.policy.costMode === 'explicit') {
    return event.costMode === 'explicit' ? event : withoutCost(event);
  }

  if (run.policy.costMode === 'estimated') {
    // Drop the logged cost first so an event we cannot price is unpriced, never a logged
    // cost presented as an estimate.
    return applyEstimatedPricingToEvent(withoutCost(event), pricing, run);
  }

  return applyEstimatedPricingToEvent(event, pricing, run);
}

function applyEstimatedPricingToEvent(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
  { policy, stats }: PricingRun,
): UsageEvent {
  const shouldRepriceExplicitZero =
    event.costMode === 'explicit' &&
    event.costUsd === 0 &&
    event.model !== undefined &&
    isPriceableEvent(event);

  if (event.costMode === 'explicit' && event.costUsd !== undefined && !shouldRepriceExplicitZero) {
    return event;
  }

  if (!event.model || !isPriceableEvent(event)) {
    return { ...event, costMode: 'estimated' };
  }

  if (!pricing) {
    if (shouldRepriceExplicitZero) {
      return event;
    }

    return { ...event, costMode: 'estimated' };
  }

  const rates = resolveRatesForEvent(event, pricing, policy.perRequestSourceIds.has(event.source));

  if (!canEstimateUsageCost(event, rates)) {
    if (shouldRepriceExplicitZero) {
      return event;
    }

    return { ...event, costMode: 'estimated' };
  }

  const pricedEvent: UsageEvent = {
    ...event,
    costUsd: calculateEstimatedCostUsd(event, rates),
    costMode: 'estimated',
  };

  if (shouldRepriceExplicitZero) {
    stats.reestimatedExplicitZero.add(pricedEvent);
  }

  if (usesPriorityFallbackRate(event, pricing)) {
    stats.priorityPriced.add(pricedEvent);
  }

  return pricedEvent;
}

const TOKENS_BY_PRIORITY_FALLBACK_BUCKET: Record<
  PriorityFallbackBucket,
  (event: UsageEvent) => number
> = {
  input: (event) => event.inputTokens,
  output: (event) => event.outputTokens,
  cacheRead: (event) => event.cacheReadTokens,
  cacheWrite: (event) => event.cacheWriteTokens,
};

/** Whether the event has tokens in a bucket that LiteLLM prices only at a priority rate. */
function usesPriorityFallbackRate(event: UsageEvent, pricing: ModelPricing): boolean {
  return (
    pricing.priorityFallback?.some(
      (bucket) => TOKENS_BY_PRIORITY_FALLBACK_BUCKET[bucket](event) > 0,
    ) ?? false
  );
}

export function applyPricingToEvents(
  events: UsageEvent[],
  pricingSource: PricingSource,
  run: PricingRun = { policy: DEFAULT_PRICING_POLICY, stats: createPricingRunStats() },
): UsageEvent[] {
  const pricingByModel = new Map<string, ModelPricing | undefined>();

  return events.map((event) => {
    const model = event.model;
    let pricing: ModelPricing | undefined;

    if (model && isPriceableEvent(event) && run.policy.costMode !== 'explicit') {
      const resolvedModel = pricingSource.resolveModelAlias(model);
      pricing = pricingByModel.get(resolvedModel);

      if (!pricingByModel.has(resolvedModel)) {
        pricing = pricingSource.getPricing(resolvedModel);
        pricingByModel.set(resolvedModel, pricing);
      }
    }

    return applyResolvedPricingToEvent(event, pricing, run);
  });
}
