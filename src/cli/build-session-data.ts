import { aggregateSessions } from '../session/aggregate-sessions.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  SessionDataResult,
} from './usage-data-contracts.js';

function parseSessionTopOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!/^\d+$/u.test(normalized) || Number.isNaN(parsed) || parsed < 1) {
    throw new Error('--top must be a positive integer');
  }

  return parsed;
}

export async function buildSessionData(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
): Promise<SessionDataResult> {
  const top = parseSessionTopOption(options.top);
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'session.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const rows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'session.aggregate', () =>
    aggregateSessions(pricedEvents, {
      timezone: dataset.normalizedInputs.timezone,
      since: options.since,
      until: options.until,
      top,
    }),
  );
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    rows,
    diagnostics,
  };
}
