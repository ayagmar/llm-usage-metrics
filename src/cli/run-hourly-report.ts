import type { HourlyCommandOptions } from './usage-data-contracts.js';

/** Placeholder until the hourly report lands; the command and its options are registered. */
export const runHourlyReport: (options: HourlyCommandOptions) => Promise<void> = async () => {
  throw new Error('The hourly report is not implemented yet');
};
