import type { ValueCommandOptions } from './usage-data-contracts.js';

/** Placeholder until the value report lands; the command and its options are registered. */
export const runValueReport: (options: ValueCommandOptions) => Promise<void> = async () => {
  throw new Error('The value report is not implemented yet');
};
