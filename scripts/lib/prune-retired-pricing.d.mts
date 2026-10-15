import type { ModelPricing } from '../../src/pricing/types.js';

export function pruneRetiredPricing(
  livePricingByModel: ReadonlyMap<string, ModelPricing>,
  retiredPricingByModel: ReadonlyMap<string, ModelPricing>,
  resolveCanonicalModelKey: (
    modelName: string,
    pricingByModel: ReadonlyMap<string, ModelPricing>,
  ) => string | undefined,
): Map<string, ModelPricing>;
