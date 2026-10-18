import type { UsageEvent } from '../domain/usage-event.js';
import { isPriceableEvent, type BillableTokenUsage } from '@ayagmar/agent-sessions/internal';
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
  /** Whether events that record a single model request (`singleRequest`) get per-request rates. */
  perRequestRates: boolean;
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
  perRequestRates: false,
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

/** Whether `policy` prices `event` at per-request rates: it applies them and the event is one request. */
export function usesPerRequestRates(
  event: UsageEvent,
  policy: Pick<PricingPolicy, 'perRequestRates'>,
): boolean {
  return policy.perRequestRates && event.singleRequest === true;
}

/** The prompt a request sent: input, cache read and cache write tokens. */
export function getPromptTokens(usage: BillableTokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * The flat rates for one event. A per-request event (`perRequest`) whose prompt (input,
 * cache read and cache write tokens) is strictly above a tier's threshold bills at the
 * highest such tier; any other event bills at the base rates. An event that sums several
 * requests must not cross a threshold on its totals, hence the gate.
 */
export function resolveRatesForEvent(
  event: BillableTokenUsage,
  pricing: ModelPricing,
  perRequest: boolean,
): ModelPricing {
  if (!perRequest || !pricing.tiers) {
    return pricing;
  }

  const promptTokens = getPromptTokens(event);
  const tier = pricing.tiers.find((candidate) => promptTokens > candidate.aboveTokens);

  return tier ? toFlatTierRates(pricing, tier) : pricing;
}

/**
 * What a long-context tier added to a per-request event's estimate: its cost at the tier's
 * rates minus its cost at the base rates. 0 when no tier applies; undefined when the event
 * cannot be estimated at either.
 */
export function estimateLongContextExtraUsd(
  event: UsageEvent,
  pricing: ModelPricing,
): number | undefined {
  const rates = resolveRatesForEvent(event, pricing, true);

  if (rates === pricing) {
    return 0;
  }

  if (!canEstimateUsageCost(event, rates) || !canEstimateUsageCost(event, pricing)) {
    return undefined;
  }

  return calculateEstimatedCostUsd(event, rates) - calculateEstimatedCostUsd(event, pricing);
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

/** What a policy does to one event, decided without building the priced event. */
type PricingOutcome =
  /** The event as it is. */
  | { type: 'unchanged' }
  /** The event marked estimated, keeping whatever cost it has. */
  | { type: 'relabelled' }
  /** The event without a cost. */
  | { type: 'unpriced' }
  | {
      type: 'priced';
      costUsd: number;
      reestimatedExplicitZero: boolean;
      priorityPriced: boolean;
    };

// Shared, so deciding an unpriced event allocates nothing.
const UNCHANGED: PricingOutcome = { type: 'unchanged' };
const RELABELLED: PricingOutcome = { type: 'relabelled' };
const UNPRICED: PricingOutcome = { type: 'unpriced' };

function resolvePricingOutcome(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
  policy: PricingPolicy,
): PricingOutcome {
  if (policy.costMode === 'explicit') {
    return event.costMode === 'explicit' ? UNCHANGED : UNPRICED;
  }

  // `estimated` drops the logged cost first so an event we cannot price is unpriced, never
  // a logged cost presented as an estimate.
  const keepsLoggedCost = policy.costMode === 'both';
  const shouldRepriceExplicitZero =
    keepsLoggedCost &&
    event.costMode === 'explicit' &&
    event.costUsd === 0 &&
    event.model !== undefined &&
    isPriceableEvent(event);

  if (
    keepsLoggedCost &&
    event.costMode === 'explicit' &&
    event.costUsd !== undefined &&
    !shouldRepriceExplicitZero
  ) {
    return UNCHANGED;
  }

  const notPriced = shouldRepriceExplicitZero ? UNCHANGED : keepsLoggedCost ? RELABELLED : UNPRICED;

  if (!event.model || !isPriceableEvent(event) || !pricing) {
    return notPriced;
  }

  const rates = resolveRatesForEvent(event, pricing, usesPerRequestRates(event, policy));

  if (!canEstimateUsageCost(event, rates)) {
    return notPriced;
  }

  return {
    type: 'priced',
    costUsd: calculateEstimatedCostUsd(event, rates),
    reestimatedExplicitZero: shouldRepriceExplicitZero,
    priorityPriced: usesPriorityFallbackRate(event, pricing, rates),
  };
}

function applyResolvedPricingToEvent(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
  { policy, stats }: PricingRun,
): UsageEvent {
  const outcome = resolvePricingOutcome(event, pricing, policy);

  switch (outcome.type) {
    case 'unchanged':
      return event;
    case 'relabelled':
      return { ...event, costMode: 'estimated' };
    case 'unpriced':
      return withoutCost(event);
    case 'priced': {
      const pricedEvent: UsageEvent = { ...event, costUsd: outcome.costUsd, costMode: 'estimated' };

      if (outcome.reestimatedExplicitZero) {
        stats.reestimatedExplicitZero.add(pricedEvent);
      }

      if (outcome.priorityPriced) {
        stats.priorityPriced.add(pricedEvent);
      }

      return pricedEvent;
    }
  }
}

/**
 * The cost `applyPricingToEvents` gives `event` under `policy`, without building the priced
 * event; undefined when the event has none, which reports count as incomplete. `pricing` is
 * the model's rates from `createModelPricingLookup`, undefined when pricing did not load.
 */
export function costUnderPolicy(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
  policy: PricingPolicy,
): number | undefined {
  const outcome = resolvePricingOutcome(event, pricing, policy);

  switch (outcome.type) {
    case 'unchanged':
    case 'relabelled':
      return event.costUsd;
    case 'unpriced':
      return undefined;
    case 'priced':
      return outcome.costUsd;
  }
}

/** A bucket's tokens billed at the model's base rate, not a tier rate or the 1h write rate. */
const TOKENS_AT_BASE_RATE: Record<
  PriorityFallbackBucket,
  (event: UsageEvent, pricing: ModelPricing, rates: ModelPricing) => number
> = {
  input: (event, pricing, rates) =>
    rates.inputPer1MUsd === pricing.inputPer1MUsd ? event.inputTokens : 0,
  output: (event, pricing, rates) =>
    rates.outputPer1MUsd === pricing.outputPer1MUsd
      ? splitOutputForBilling(event, rates).outputTokens
      : 0,
  cacheRead: (event, pricing, rates) =>
    rates.cacheReadPer1MUsd === pricing.cacheReadPer1MUsd ? event.cacheReadTokens : 0,
  cacheWrite: (event, pricing, rates) => {
    if (rates.cacheWritePer1MUsd !== pricing.cacheWritePer1MUsd) {
      return 0;
    }

    const fiveMinuteTokens = event.cacheWriteTokens - event.cacheWrite1hTokens;
    return rates.cacheWrite1hPer1MUsd === undefined
      ? fiveMinuteTokens + event.cacheWrite1hTokens
      : fiveMinuteTokens;
  },
};

/**
 * Whether the event bills tokens at a rate LiteLLM lists only as a priority rate: tokens in
 * a fallback bucket priced at the base rate, not by a long-context tier or the 1h write rate.
 */
function usesPriorityFallbackRate(
  event: UsageEvent,
  pricing: ModelPricing,
  rates: ModelPricing,
): boolean {
  return (
    pricing.priorityFallback?.some(
      (bucket) => TOKENS_AT_BASE_RATE[bucket](event, pricing, rates) > 0,
    ) ?? false
  );
}

/**
 * The rates for an event's model, resolving each model once; undefined when the event is
 * not priced from tokens under `costMode`.
 */
export function createModelPricingLookup(
  pricingSource: PricingSource,
  costMode: PricingCostMode,
): (event: UsageEvent) => ModelPricing | undefined {
  const pricingByModel = new Map<string, ModelPricing | undefined>();
  // A run repeats a few model names, so each name's rates are kept too: most events skip
  // the alias lookup.
  const pricingByName = new Map<string, ModelPricing | undefined>();

  return (event) => {
    const model = event.model;

    if (!model || !isPriceableEvent(event) || costMode === 'explicit') {
      return undefined;
    }

    if (pricingByName.has(model)) {
      return pricingByName.get(model);
    }

    const resolvedModel = pricingSource.resolveModelAlias(model);

    if (!pricingByModel.has(resolvedModel)) {
      pricingByModel.set(resolvedModel, pricingSource.getPricing(resolvedModel));
    }

    const pricing = pricingByModel.get(resolvedModel);
    pricingByName.set(model, pricing);
    return pricing;
  };
}

export function applyPricingToEvents(
  events: UsageEvent[],
  pricingSource: PricingSource,
  run: PricingRun = { policy: DEFAULT_PRICING_POLICY, stats: createPricingRunStats() },
): UsageEvent[] {
  const lookupPricing = createModelPricingLookup(pricingSource, run.policy.costMode);

  return events.map((event) => applyResolvedPricingToEvent(event, lookupPricing(event), run));
}
