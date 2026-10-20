import type { ModelPricing } from '../../packages/core/src/pricing/types.js';

export function pricingProbeNames(modelName: string): string[];

export function pruneRetiredPricing(
  livePricingByModel: ReadonlyMap<string, ModelPricing>,
  retiredPricingByModel: ReadonlyMap<string, ModelPricing>,
  resolveCanonicalModelKey: (
    modelName: string,
    pricingByModel: ReadonlyMap<string, ModelPricing>,
  ) => string | undefined,
): Map<string, ModelPricing>;

export function namesReachingPricing(
  names: Iterable<string>,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
  resolveCanonicalModelKey: (
    modelName: string,
    pricingByModel: ReadonlyMap<string, ModelPricing>,
  ) => string | undefined,
): string[];
