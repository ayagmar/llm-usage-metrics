import type { PricingCommandOptions } from './usage-data-contracts.js';

/** Placeholder until the pricing report lands; the command and its options are registered. */
export const runPricingReport: (
  models: string[],
  options: PricingCommandOptions,
) => Promise<void> = async () => {
  throw new Error('The pricing report is not implemented yet');
};
