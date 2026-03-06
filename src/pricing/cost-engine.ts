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

export function calculateEstimatedCostUsd(event: UsageEvent, pricing: ModelPricing): number {
  const reasoningBilling = pricing.reasoningBilling ?? 'included-in-output';

  const inputCost = estimateTokenGroupCost(event.inputTokens, pricing.inputPer1MUsd);
  const outputCost = estimateTokenGroupCost(event.outputTokens, pricing.outputPer1MUsd);
  const cacheReadCost = estimateTokenGroupCost(event.cacheReadTokens, pricing.cacheReadPer1MUsd);
  const cacheWriteCost = estimateTokenGroupCost(event.cacheWriteTokens, pricing.cacheWritePer1MUsd);

  const reasoningCost =
    reasoningBilling === 'separate'
      ? estimateTokenGroupCost(event.reasoningTokens, pricing.reasoningPer1MUsd)
      : 0;

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

export function canEstimateUsageCost(usage: BillableTokenUsage, pricing: ModelPricing): boolean {
  if (hasNonReasoningPricedBuckets(usage)) {
    return true;
  }

  return usage.reasoningTokens > 0 && pricing.reasoningBilling === 'separate';
}

export function applyPricingToEvent(event: UsageEvent, pricingSource: PricingSource): UsageEvent {
  const pricing =
    event.model && isPriceableEvent(event) ? pricingSource.getPricing(event.model) : undefined;

  return applyResolvedPricingToEvent(event, pricing);
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
