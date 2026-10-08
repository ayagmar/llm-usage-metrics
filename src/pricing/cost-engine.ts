import {
  isPriceableEvent,
  type BillableTokenUsage,
  type UsageEvent,
} from '../domain/usage-event.js';
import type { ModelPricing, PricingSource } from './types.js';

const ONE_MILLION = 1_000_000;

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
  const cacheWriteCost = estimateTokenGroupCost(event.cacheWriteTokens, pricing.cacheWritePer1MUsd);
  const reasoningCost = estimateTokenGroupCost(
    billedOutput.reasoningTokens,
    pricing.reasoningPer1MUsd,
  );

  return inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost;
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

function applyResolvedPricingToEvent(
  event: UsageEvent,
  pricing: ModelPricing | undefined,
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

  if (!canEstimateUsageCost(event, pricing)) {
    if (shouldRepriceExplicitZero) {
      return event;
    }

    return { ...event, costMode: 'estimated' };
  }

  return {
    ...event,
    costUsd: calculateEstimatedCostUsd(event, pricing),
    costMode: 'estimated',
  };
}

export function applyPricingToEvents(
  events: UsageEvent[],
  pricingSource: PricingSource,
): UsageEvent[] {
  const pricingByModel = new Map<string, ModelPricing | undefined>();

  return events.map((event) => {
    const model = event.model;
    let pricing: ModelPricing | undefined;

    if (model && isPriceableEvent(event)) {
      const resolvedModel = pricingSource.resolveModelAlias(model);
      pricing = pricingByModel.get(resolvedModel);

      if (!pricingByModel.has(resolvedModel)) {
        pricing = pricingSource.getPricing(resolvedModel);
        pricingByModel.set(resolvedModel, pricing);
      }
    }

    return applyResolvedPricingToEvent(event, pricing);
  });
}
