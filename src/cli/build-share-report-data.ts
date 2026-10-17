import os from 'node:os';

import {
  buildProjectLabels,
  toProjectKey,
  UNATTRIBUTED_PROJECT_LABEL,
} from '../aggregate/project-key.js';
import { aggregateBlocks, BLOCK_HOURS } from '../blocks/aggregate-blocks.js';
import { getLocalDayStartMs } from '../blocks/local-day-start.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import {
  costUnderPolicy,
  createModelPricingLookup,
  type PricingPolicy,
} from '../pricing/cost-engine.js';
import type { PricingSource } from '../pricing/types.js';
import {
  buildSharePayload,
  SHARE_COST_MODES,
  type ShareEventCosts,
} from '../share-report/build-share-payload.js';
import {
  buildRedactionMap,
  buildShareProjectLabels,
  createPathScrubber,
  KEPT_MACHINE_LABELS,
  KEPT_PROJECT_LABELS,
  toShareModelLabel,
} from '../share-report/redact.js';
import {
  collectEnvelopeProjectKeys,
  sanitizeEmbeddedEnvelope,
} from '../share-report/sanitize-envelope.js';
import type {
  ShareCommand,
  ShareCostMode,
  ShareDateRange,
  ShareEmbeddedEnvelope,
  ShareReportData,
  ShareReportMeta,
} from '../share-report/types.js';
import { logger } from '../utils/logger.js';
import { shiftDateKey } from '../utils/date-key.js';
import { getCurrentLocalDateKey, getPeriodKey } from '../utils/time-buckets.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { BLOCKS_LOOKBACK_DAYS, readWholeStreams } from './build-blocks-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import {
  getPerRequestSourceIds,
  resolvePricingPolicy,
  resolvePricingSource,
  shouldLoadPricingSource,
} from './build-usage-data-pricing.js';
import { buildUsageEventDataset } from './build-usage-event-dataset.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type { BuildUsageDataDeps, ReportCommandOptions } from './usage-data-contracts.js';

/** What a command passes to build its share report. */
export type ShareReportRequest = {
  command: ShareCommand;
  /** The command's options; the dates come from `window`, and other machines are never synced. */
  options: ReportCommandOptions;
  /** The command's resolved window (compare: baseline start to current end). */
  window: ShareDateRange;
  initialView: ShareReportMeta['initialView'];
  /** The command's own report JSON, for compare, efficiency, optimize and wrapped. */
  envelope?: Pick<ShareEmbeddedEnvelope, 'report' | 'data'>;
  /** Payload bytes above which older cells roll up to days; the default keeps the HTML under 8 MB. */
  targetBytes?: number;
  /**
   * The events the command reports out of those its filters select, when it narrows them
   * further (efficiency: its repository, in periods with commits). Blocks still place
   * against every selected event.
   */
  scopeEvents?: (events: UsageEvent[], timezone: string) => Promise<UsageEvent[]>;
};

type ModeCosts = {
  costs: ShareEventCosts;
  unavailable: ShareCostMode[];
};

/**
 * Each event's cost in every mode from one pricing load. The command's own run already failed
 * if its mode needed prices that did not load, so a failure here only drops the estimated
 * modes, with a warning.
 */
async function priceEveryMode(
  events: UsageEvent[],
  options: ReportCommandOptions,
  policy: PricingPolicy,
  runtimeConfig: Parameters<typeof resolvePricingSource>[1],
  deps: BuildUsageDataDeps,
): Promise<ModeCosts> {
  if (options.cost === false) {
    return { costs: {}, unavailable: [] };
  }

  let pricingSource: PricingSource | undefined;
  let unavailable: ShareCostMode[] = [];

  // `estimated` looks up every priced event's model, so it decides for all three modes.
  if (shouldLoadPricingSource(events, 'estimated')) {
    try {
      const loadPricingSource = deps.resolvePricingSource ?? resolvePricingSource;
      pricingSource = (await loadPricingSource(options, runtimeConfig)).source;
    } catch (error) {
      unavailable = ['estimated', 'both'];
      logger.warn(
        `Share report: pricing did not load, so it holds logged costs only: ${getErrorReason(error)}`,
      );
    }
  }

  const costs: ShareEventCosts = {};

  for (const costMode of SHARE_COST_MODES.filter((mode) => !unavailable.includes(mode))) {
    const lookupPricing = pricingSource
      ? createModelPricingLookup(pricingSource, costMode)
      : () => undefined;
    const modePolicy = { ...policy, costMode };
    costs[costMode] = events.map((event) =>
      costUnderPolicy(event, lookupPricing(event), modePolicy),
    );
  }

  return { costs, unavailable };
}

function pickCosts(costs: ShareEventCosts, keep: readonly boolean[]): ShareEventCosts {
  const picked: ShareEventCosts = {};

  for (const mode of SHARE_COST_MODES) {
    picked[mode] = costs[mode]?.filter((_, index) => keep[index]);
  }

  return picked;
}

function sumTokensBy(
  events: readonly UsageEvent[],
  label: (event: UsageEvent) => string,
  extraLabels: Iterable<string> = [],
): Map<string, number> {
  const tokens = new Map<string, number>();

  for (const event of events) {
    const key = label(event);
    tokens.set(key, (tokens.get(key) ?? 0) + event.totalTokens);
  }

  for (const key of extraLabels) {
    if (!tokens.has(key)) {
      tokens.set(key, 0);
    }
  }

  return tokens;
}

/** Looks a label up in a redaction map; a name it lacks gets the next stand-in. */
function createRedactor(
  tokensByLabel: ReadonlyMap<string, number>,
  prefix: string,
  keep: ReadonlySet<string>,
): (label: string) => string {
  const redaction = buildRedactionMap(tokensByLabel, prefix, keep);

  return (label) => {
    if (keep.has(label)) {
      return label;
    }

    let redacted = redaction.get(label);

    if (redacted === undefined) {
      const assigned = [...redaction.values()].filter((value) => value.startsWith(`${prefix}-`));
      redacted = `${prefix}-${String(assigned.length + 1)}`;
      redaction.set(label, redacted);
    }

    return redacted;
  };
}

/**
 * The payload of a `--share` report: the command's window and filters read again (never
 * syncing other machines), priced in every cost mode from one pricing load, with blocks
 * placed as the `blocks` command places them. Labels never hold a path; with --redact,
 * projects and machines are `project-N` and `machine-N`.
 */
export async function buildShareReportData(
  request: ShareReportRequest,
  deps: BuildUsageDataDeps = {},
): Promise<ShareReportData> {
  const userConfigResolution = await resolveUserConfigForOptions(request.options, deps);
  const configuredOptions = userConfigResolution.options;
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const now = deps.now?.() ?? new Date();
  const { since, until } = request.window;
  const lookbackSince = since === null ? undefined : shiftDateKey(since, -BLOCKS_LOOKBACK_DAYS);
  const datasetOptions: ReportCommandOptions = {
    ...configuredOptions,
    since: lookbackSince,
    until: until ?? undefined,
    sync: false,
  };
  const datasetConfigResolution = { ...userConfigResolution, options: datasetOptions };
  const datasetDeps: BuildUsageDataDeps = {
    ...deps,
    userConfigResolution: datasetConfigResolution,
  };
  const runtimeProfile = deps.runtimeProfile;

  const dataset = await measureRuntimeProfileStage(runtimeProfile, 'share.dataset', () =>
    buildUsageEventDataset(datasetOptions, datasetDeps),
  );
  const wholeStreams = await measureRuntimeProfileStage(runtimeProfile, 'share.whole_streams', () =>
    readWholeStreams(dataset, datasetConfigResolution, deps),
  );
  const allEvents = request.scopeEvents
    ? await request.scopeEvents(dataset.filteredEvents, timezone)
    : dataset.filteredEvents;
  const inWindow = allEvents.map(
    (event) => since === null || getPeriodKey(event.timestamp, 'daily', timezone) >= since,
  );
  const windowEvents = allEvents.filter((_, index) => inWindow[index]);

  const policy = resolvePricingPolicy(
    dataset.options,
    getPerRequestSourceIds(dataset.adaptersToParse),
  );
  const { costs, unavailable } = await measureRuntimeProfileStage(
    runtimeProfile,
    'share.pricing',
    () =>
      priceEveryMode(
        allEvents,
        { ...dataset.options, pricingUrl: dataset.normalizedInputs.pricingUrl },
        policy,
        dataset.pricingRuntimeConfig,
        deps,
      ),
  );

  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  const blocks = measureRuntimeProfileStageSync(runtimeProfile, 'share.blocks', () =>
    aggregateBlocks(allEvents, {
      sinceMs: since === null ? undefined : getLocalDayStartMs(since, timezone),
      rangeStartMs:
        lookbackSince === undefined ? undefined : getLocalDayStartMs(lookbackSince, timezone),
      sourceOrder,
      contextEvents:
        wholeStreams.events ?? (request.scopeEvents ? dataset.filteredEvents : undefined),
    }),
  );

  const envelopeKeys = request.envelope ? collectEnvelopeProjectKeys(request.envelope.data) : [];
  const projectKeys = [
    ...windowEvents.map((event) => toProjectKey(event.repoRoot)),
    ...envelopeKeys,
  ];
  const homeDir = os.homedir();
  const shareLabels = buildShareProjectLabels(projectKeys, homeDir);
  const shareLabel = (key: string | undefined) =>
    shareLabels.get(key) ?? UNATTRIBUTED_PROJECT_LABEL;
  const machineFilter = [...(dataset.normalizedInputs.machineFilter ?? [])];
  const redact = request.options.redact === true;
  const redactProject = createRedactor(
    sumTokensBy(windowEvents, (event) => shareLabel(toProjectKey(event.repoRoot)), [
      ...shareLabels.values(),
    ]),
    'project',
    KEPT_PROJECT_LABELS,
  );
  const redactMachine = createRedactor(
    sumTokensBy(windowEvents, (event) => event.machine ?? LOCAL_MACHINE_NAME, machineFilter),
    'machine',
    KEPT_MACHINE_LABELS,
  );
  const projectLabelForKey = (key: string | undefined) => {
    const label = shareLabel(key);
    return redact ? redactProject(label) : label;
  };
  const machineLabel = (machine: string) => (redact ? redactMachine(machine) : machine);

  const payload = measureRuntimeProfileStageSync(runtimeProfile, 'share.payload', () =>
    buildSharePayload({
      events: windowEvents,
      costs: pickCosts(costs, inWindow),
      timezone,
      sourceOrder,
      projectLabel: (repoRoot) => projectLabelForKey(toProjectKey(repoRoot)),
      machineLabel,
      blocks,
      blockEvents: allEvents,
      blockCosts: costs,
      blockHours: BLOCK_HOURS,
      windowEnd: until ?? getCurrentLocalDateKey(timezone, now),
      targetBytes: request.targetBytes,
    }),
  );

  const meta: ShareReportMeta = {
    generatedAt: now.toISOString(),
    toolVersion: loadPackageMetadataFromRuntime().packageVersion,
    command: request.command,
    timezone,
    window: request.window,
    initialView: request.initialView,
    hourlyFrom: payload.hourlyFrom,
    costMode: request.options.cost === false ? null : policy.costMode,
    unavailableCostModes: unavailable,
    redacted: redact,
    filters: {
      sources: [...(dataset.normalizedInputs.sourceFilter ?? [])].sort(),
      providers:
        dataset.normalizedInputs.providerFilter === undefined
          ? []
          : [dataset.normalizedInputs.providerFilter],
      models: [
        ...new Set((dataset.normalizedInputs.modelFilter ?? []).map(toShareModelLabel)),
      ].sort(),
      machines: machineFilter.map(machineLabel).sort(),
      repo: dataset.normalizedInputs.repoFilter !== undefined,
    },
  };

  const data: ShareReportData = {
    meta,
    dictionaries: payload.dictionaries,
    cube: payload.cube,
    sessions: payload.sessions,
    blocks: payload.blocks,
  };

  if (!request.envelope) {
    return data;
  }

  // The command labelled projects over its own keys; map its labels to this file's.
  const commandLabels = buildProjectLabels(projectKeys);
  const keyByCommandLabel = new Map([...commandLabels].map(([key, label]) => [label, key]));
  const pathReplacements = new Map<string, string>([[homeDir, '~']]);

  for (const event of windowEvents) {
    if (event.repoRoot !== undefined) {
      pathReplacements.set(event.repoRoot, projectLabelForKey(toProjectKey(event.repoRoot)));
    }
  }

  for (const key of envelopeKeys) {
    pathReplacements.set(key, projectLabelForKey(key));
  }

  // Names the envelope's free text may hold, as this file shows them.
  const names = new Map(
    [...commandLabels].map(([key, label]) => [label, projectLabelForKey(key)] as const),
  );

  if (redact) {
    for (const label of shareLabels.values()) {
      names.set(label, redactProject(label));
    }

    for (const machine of [
      ...windowEvents.map((event) => event.machine ?? LOCAL_MACHINE_NAME),
      ...machineFilter,
    ]) {
      names.set(machine, machineLabel(machine));
    }
  }

  return {
    ...data,
    envelope: sanitizeEmbeddedEnvelope(request.envelope, {
      projectLabelForKey: (key) => (shareLabels.has(key) ? projectLabelForKey(key) : undefined),
      projectLabelForLabel: (label) =>
        keyByCommandLabel.has(label)
          ? projectLabelForKey(keyByCommandLabel.get(label))
          : redact
            ? redactProject(label)
            : undefined,
      machineLabel,
      scrub: createPathScrubber(pathReplacements),
      names,
    }),
  };
}
