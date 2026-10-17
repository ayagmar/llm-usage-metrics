import {
  aggregateBlocks,
  BLOCK_DURATION_MS,
  BLOCK_HOURS,
  computeBurnRate,
  isBlockActive,
  resolveBlockRanking,
  selectTopBlocks,
  type BlockBurnRate,
  type BlockRanking,
  type UsageBlock,
} from '../blocks/aggregate-blocks.js';
import { getLocalDayStartMs } from '../blocks/local-day-start.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import { getCurrentLocalDateKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions, type UserConfigResolution } from './apply-user-config.js';
import { resolveUsageDataRequest } from './build-usage-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
  type UsageEventDataset,
} from './build-usage-event-dataset.js';
import { filterParsedAdapterEvents } from './parse/usage-event-filters.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BlocksCommandOptions,
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';
import { parsePositiveTopOption } from './top-option.js';

const HOUR_MS = 60 * 60 * 1000;

/** Days read before `since` to find where the chain of blocks running into it started. */
export const BLOCKS_LOOKBACK_DAYS = 7;

/** A block, with its burn rate when it contains now. */
export type BlockRow = UsageBlock & {
  active: BlockBurnRate | null;
};

export type BlocksReportData = {
  /** Blocks are estimates: the 5-hour window rule is a community convention. */
  estimated: true;
  blockHours: number;
  timezone: string;
  /** First day of the window (YYYY-MM-DD); null for the full history. */
  since: string | null;
  /** Last day of the window (YYYY-MM-DD); null when open-ended. */
  until: string | null;
  /** With --top: how many blocks were asked for and what ranked them. */
  top: { count: number; rankedBy: BlockRanking } | null;
  /** Blocks in the window before --top. */
  blockCount: number;
  /** In time order, or by rank with --top. */
  blocks: BlockRow[];
  /** Blocks containing now, whether or not --top shows them. */
  activeBlocks: BlockRow[];
};

export type BlocksDataResult = {
  data: BlocksReportData;
  diagnostics: UsageDiagnostics;
  /** Set when no window flag was given, for the default-window hint. */
  defaultWindowSince?: string;
};

/** The events counted in `blocks`: each lies in one block of its source, at most 5 h after its start. */
function selectBlockEvents(events: readonly UsageEvent[], blocks: readonly UsageBlock[]) {
  const blockKeys = new Set(blocks.map((block) => `${block.source}\0${Date.parse(block.start)}`));

  return events.filter((event) => {
    const hourMs = Math.floor(Date.parse(event.timestamp) / HOUR_MS) * HOUR_MS;

    for (let startMs = hourMs; startMs > hourMs - BLOCK_DURATION_MS; startMs -= HOUR_MS) {
      if (blockKeys.has(`${event.source}\0${startMs}`)) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Each source's whole stream over the dataset's dates when --repo, --model, --provider or
 * --machine narrowed the events, so blocks keep the account's windows; undefined when
 * nothing narrowed them. --machine leaves other machines out of the dataset, so it reads
 * the dataset again, from the machines' cached usage without refreshing them (with no
 * other machine configured, --machine can only name this one, which narrows nothing).
 * Its warnings the report's own read did not give come back too, such as a machine whose
 * cache cannot be read: the windows were placed without it.
 */
export async function readWholeStreams(
  dataset: UsageEventDataset,
  userConfigResolution: UserConfigResolution,
  deps: BuildUsageDataDeps,
): Promise<{ events?: UsageEvent[]; warnings: string[] }> {
  const datasetOptions = userConfigResolution.options;
  const { timezone, providerFilter, modelFilter, repoFilter, machineFilter } =
    dataset.normalizedInputs;
  const otherMachines = Object.keys(userConfigResolution.loadedConfig.config.machines ?? {});

  if (machineFilter && otherMachines.length > 0) {
    const wholeOptions: ReportCommandOptions = {
      ...datasetOptions,
      // Named, not left unset: a run with a custom source directory and no --machine
      // leaves other machines out.
      machine: [LOCAL_MACHINE_NAME, ...otherMachines],
      provider: undefined,
      model: undefined,
      repo: undefined,
      sync: false,
    };
    const whole = await buildUsageEventDataset(wholeOptions, {
      ...deps,
      userConfigResolution: { ...userConfigResolution, options: wholeOptions },
    });
    const reported = new Set(dataset.warnings);

    return {
      events: whole.filteredEvents,
      warnings: whole.warnings
        .filter((warning) => !reported.has(warning))
        .map((warning) => `Account window (blocks across every machine): ${warning}`),
    };
  }

  if (providerFilter === undefined && modelFilter === undefined && repoFilter === undefined) {
    return { warnings: [] };
  }

  return {
    events: filterParsedAdapterEvents(dataset.successfulParseResults, {
      timezone,
      since: datasetOptions.since,
      until: datasetOptions.until,
    }),
    warnings: [],
  };
}

export async function buildBlocksData(
  options: BlocksCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<BlocksDataResult> {
  const top = parsePositiveTopOption(options.top);
  // Without date flags, the last 7 days, as `daily` reports them.
  const windowRequest = await resolveUsageDataRequest('daily', options, deps);
  const userConfigResolution = await resolveUserConfigForOptions(
    windowRequest.options,
    windowRequest.deps,
  );
  const configuredOptions = userConfigResolution.options;
  const window = { since: configuredOptions.since, until: configuredOptions.until };
  // Validates the dates and the timezone before they are used here.
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const now = deps.now?.() ?? new Date();
  const today = getCurrentLocalDateKey(timezone, now);
  // Read a week before the window, once, to find where the blocks running into it started.
  const lookbackSince =
    window.since === undefined ? undefined : shiftLocalDateKey(window.since, -BLOCKS_LOOKBACK_DAYS);
  const datasetOptions = { ...configuredOptions, since: lookbackSince, until: window.until };
  const datasetDeps = {
    ...deps,
    userConfigResolution: { ...userConfigResolution, options: datasetOptions },
  };

  const hideCost = options.cost === false;
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'blocks.dataset.total',
    () => buildUsageEventDataset(datasetOptions, datasetDeps),
  );
  // --no-cost shows no cost, so prices are neither loaded nor fetched.
  const pricingResult = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    hideCost ? 'none' : 'auto',
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  const wholeStreams = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'blocks.whole_streams',
    () => readWholeStreams(dataset, datasetDeps.userConfigResolution, deps),
  );

  const blocks = measureRuntimeProfileStageSync(deps.runtimeProfile, 'blocks.aggregate', () =>
    aggregateBlocks(pricedEvents, {
      sinceMs: window.since === undefined ? undefined : getLocalDayStartMs(window.since, timezone),
      rangeStartMs:
        lookbackSince === undefined ? undefined : getLocalDayStartMs(lookbackSince, timezone),
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
      contextEvents: wholeStreams.events,
    }),
  );

  const nowMs = now.getTime();
  // A window that ended before today has no block in progress.
  const canBeActive = window.until === undefined || window.until >= today;
  const toRow = (block: UsageBlock): BlockRow => ({
    ...block,
    active: canBeActive && isBlockActive(block, nowMs) ? computeBurnRate(block, nowMs) : null,
  });
  const rows = blocks.map(toRow);
  const rankedBy = resolveBlockRanking(blocks, { hideCost });
  const shownRows = top === undefined ? rows : selectTopBlocks(rows, top, rankedBy);

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: [...dataset.warnings, ...wholeStreams.warnings],
    notes: hideCost
      ? dataset.notes
      : withPricingNotes(dataset.notes, selectBlockEvents(pricedEvents, shownRows), pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    data: {
      estimated: true,
      blockHours: BLOCK_HOURS,
      timezone,
      since: window.since ?? null,
      until: window.until ?? null,
      top: top === undefined ? null : { count: top, rankedBy },
      blockCount: rows.length,
      blocks: shownRows,
      activeBlocks: rows.filter((row) => row.active !== null),
    },
    diagnostics,
    ...(windowRequest.defaultWindowSince
      ? { defaultWindowSince: windowRequest.defaultWindowSince }
      : {}),
  };
}
