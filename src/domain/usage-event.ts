import * as core from '@ayagmar/agent-sessions';

export * from '@ayagmar/agent-sessions';

/** How reports and `--machine` name this machine, next to the configured ones. */
export const LOCAL_MACHINE_NAME = 'local';

export type UsageEvent = core.UsageEvent & {
  costMode: core.CostMode;

  /** The configured machine the event came from; undefined for this machine's own usage. */
  machine?: string;
};

export type UsageEventInput = core.UsageEventInput & {
  costMode?: core.CostMode;
};

function resolveCostMode(
  costMode: core.CostMode | undefined,
  costUsd: number | undefined,
): core.CostMode {
  if (costMode === 'explicit' && costUsd === undefined) {
    throw new Error('UsageEvent with costMode "explicit" requires costUsd');
  }

  if (costMode) {
    return costMode;
  }

  return costUsd === undefined ? 'estimated' : 'explicit';
}

export function createUsageEvent(input: UsageEventInput): UsageEvent {
  if (!core.normalizeSourceId(input.source)) {
    throw new Error('UsageEvent source must be a non-empty string');
  }

  const costMode = resolveCostMode(input.costMode, core.normalizeUsdCost(input.costUsd));

  return Object.assign(core.createUsageEvent(input), { costMode });
}
