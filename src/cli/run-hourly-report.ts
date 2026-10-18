import { runUsageReport } from './run-usage-report.js';
import type { HourlyCommandOptions } from './usage-data-contracts.js';

/** The usage report hour by hour; today unless `--last`, `--since`, or `--until`. */
export async function runHourlyReport(options: HourlyCommandOptions): Promise<void> {
  await runUsageReport('hourly', options);
}
