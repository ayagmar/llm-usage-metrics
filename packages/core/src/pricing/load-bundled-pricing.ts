import {
  createLiteLLMPricingTable,
  forgetOnRejection,
  packagedPricingData,
  toPricingMap,
} from './litellm-pricing-fetcher.js';
import type { PricingSource } from './types.js';

let bundledPricingSource: Promise<PricingSource> | undefined;

/**
 * The LiteLLM prices bundled with this package: the snapshot, with retired models
 * back-filled and the bundled context limits. Reads the data files on the first call and
 * returns the same source after that; a failed read is retried on the next call. Makes no
 * network call. The source is shared: do not change the rates it returns.
 */
export function loadBundledPricing(): Promise<PricingSource> {
  bundledPricingSource ??= forgetOnRejection(
    packagedPricingData.snapshot().then((snapshot) =>
      createLiteLLMPricingTable(toPricingMap(snapshot.pricingByModel), {
        origin: {
          kind: 'bundled-snapshot',
          fetchedAt: snapshot.fetchedAt,
          url: snapshot.sourceUrl,
        },
        bundledPricing: packagedPricingData,
      }),
    ),
    () => {
      bundledPricingSource = undefined;
    },
  );
  return bundledPricingSource;
}
