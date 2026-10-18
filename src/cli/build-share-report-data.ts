import os from 'node:os';
import path from 'node:path';

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
  createNameReplacer,
  createPathScrubber,
  isPathLike,
  isPathShapedModel,
  KEPT_MACHINE_LABELS,
  KEPT_MODEL_LABELS,
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
import { logger, withLogScrubber } from '../utils/logger.js';
import { getCurrentLocalDateKey, getPeriodKey } from '../utils/time-buckets.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { readBlocksDataset } from './build-blocks-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import {
  resolvePricingPolicy,
  resolvePricingSource,
  shouldLoadPricingSource,
} from './build-usage-data-pricing.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import { getSourceOverrideOptions } from './source-cli-options.js';
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
  /** Paths the command takes beyond the shared options (efficiency's repository). */
  inputPaths?: readonly string[];
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
  /** The prices loaded, if they were needed and loaded. */
  pricingSource?: PricingSource;
  /** Why prices did not load; warned once the file's names are known (--redact hides them). */
  pricingWarning?: string;
};

/**
 * Each event's cost in every mode from one pricing load. The command's own run already failed
 * if its mode needed prices that did not load, so a failure here only drops the estimated
 * modes, with a warning. With --redact, prices load even under --no-cost, since they list the
 * models the file may name.
 */
async function priceEveryMode(
  events: UsageEvent[],
  options: ReportCommandOptions,
  policy: PricingPolicy,
  runtimeConfig: Parameters<typeof resolvePricingSource>[1],
  deps: BuildUsageDataDeps,
): Promise<ModeCosts> {
  const withCosts = options.cost !== false;
  const redact = options.redact === true;

  if (!withCosts && !redact) {
    return { costs: {}, unavailable: [] };
  }

  let pricingSource: PricingSource | undefined;
  let pricingWarning: string | undefined;
  let unavailable: ShareCostMode[] = [];

  // `estimated` looks up every priced event's model, so it decides for all three modes.
  if (
    (redact && events.length > 0) ||
    (withCosts && shouldLoadPricingSource(events, 'estimated'))
  ) {
    try {
      const loadPricingSource = deps.resolvePricingSource ?? resolvePricingSource;
      pricingSource = (await loadPricingSource(options, runtimeConfig)).source;
    } catch (error) {
      const outcomes = [
        ...(withCosts ? ['holds logged costs only'] : []),
        ...(redact ? ['labels every model model-N'] : []),
      ];
      unavailable = withCosts ? ['estimated', 'both'] : [];
      pricingWarning = `Share report: pricing did not load, so it ${outcomes.join(' and ')}: ${getErrorReason(error)}`;
    }
  }

  if (!withCosts) {
    return { costs: {}, unavailable, pricingSource, pricingWarning };
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

  return { costs, unavailable, pricingSource, pricingWarning };
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

/**
 * The paths a run was given, as typed and resolved: source directories, `--source-dir`
 * entries, the config file, path env overrides, and the command's own (`--repo-dir`). Its
 * stderr may print one whole, spaces and all, where the generic path matcher stops at a space.
 * A bare root is left out, since it would match every separator.
 */
function listInputPaths(
  options: ReportCommandOptions,
  configPath: string,
  commandPaths: readonly string[],
): string[] {
  const values = [
    ...getSourceOverrideOptions().flatMap(({ optionKey }) => options[optionKey] ?? []),
    ...(options.sourceDir ?? []).map((entry) => entry.slice(entry.indexOf('=') + 1)),
    configPath,
    ...getActiveEnvVarOverrides()
      .filter(({ name }) => name.endsWith('_PATH'))
      .map(({ value }) => value),
    ...commandPaths,
  ];

  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .flatMap((value) => [value, path.resolve(value)])
    .filter((value) => path.parse(value).root !== value && isPathLike(value));
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
 * Whether `--redact` hides a model: one whose name holds a path, or that LiteLLM does not list
 * (a local or custom model, even one a pricing override prices). Without prices, every model.
 */
function createHiddenModelCheck(
  pricingSource: PricingSource | undefined,
): (model: string) => boolean {
  const isListed = (model: string) => {
    if (pricingSource === undefined) {
      return false;
    }

    // An override keyed on the name itself prices it without a LiteLLM key (no `match`).
    return pricingSource.explainModel
      ? pricingSource.explainModel(model).match !== undefined
      : pricingSource.getPricing(pricingSource.resolveModelAlias(model)) !== undefined;
  };
  const hidden = new Map<string, boolean>();

  return (model) => {
    let isHidden = hidden.get(model);

    if (isHidden === undefined) {
      isHidden = isPathShapedModel(model.trim().toLowerCase()) || !isListed(model);
      hidden.set(model, isHidden);
    }

    return isHidden;
  };
}

/**
 * The payload of a `--share` report: the command's window and filters read again (never
 * syncing other machines), priced in every cost mode from one pricing load, with blocks
 * placed as the `blocks` command places them. Labels never hold a path; with --redact,
 * projects and machines are `project-N` and `machine-N`, and so are models whose name holds a
 * path or that LiteLLM does not list (`model-N`).
 */
export async function buildShareReportData(
  request: ShareReportRequest,
  deps: BuildUsageDataDeps = {},
): Promise<ShareReportData> {
  return (await buildShareReport(request, deps)).data;
}

export type ShareReport = {
  data: ShareReportData;
  /**
   * With --redact, hides in a stderr line what the file hides: paths become `<path>` (known
   * repository roots their label), and project, machine and model names their stand-ins.
   */
  scrubLog?: (message: string) => string;
};

/** The payload of a `--share` report (see `buildShareReportData`) and its stderr scrubber. */
export async function buildShareReport(
  request: ShareReportRequest,
  deps: BuildUsageDataDeps = {},
): Promise<ShareReport> {
  const userConfigResolution = await resolveUserConfigForOptions(request.options, deps);
  const configuredOptions = userConfigResolution.options;
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const now = deps.now?.() ?? new Date();
  const { since, until } = request.window;
  const datasetOptions: ReportCommandOptions = {
    ...configuredOptions,
    since: since ?? undefined,
    until: until ?? undefined,
    sync: false,
  };
  const runtimeProfile = deps.runtimeProfile;

  const { dataset, lookbackSince, events, wholeStreams } = await readBlocksDataset(
    datasetOptions,
    userConfigResolution,
    deps,
    'share',
  );
  const allEvents = request.scopeEvents ? await request.scopeEvents(events, timezone) : events;
  const inWindow = allEvents.map(
    (event) => since === null || getPeriodKey(event.timestamp, 'daily', timezone) >= since,
  );
  const windowEvents = allEvents.filter((_, index) => inWindow[index]);

  const policy = resolvePricingPolicy(dataset.options, true);
  const { costs, unavailable, pricingSource, pricingWarning } = await measureRuntimeProfileStage(
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
      contextEvents: wholeStreams.events ?? (request.scopeEvents ? events : undefined),
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
  const modelFilter = dataset.normalizedInputs.modelFilter ?? [];
  const isHiddenModel = createHiddenModelCheck(pricingSource);
  // Decided over every model the file can name first, so the stand-ins rank by tokens.
  const hiddenModels = new Set(
    [...allEvents.map((event) => event.model), ...modelFilter]
      .filter((model) => model !== undefined && isHiddenModel(model))
      .map(toShareModelLabel),
  );
  const redactModel = createRedactor(
    new Map(
      [
        ...sumTokensBy(windowEvents, (event) => toShareModelLabel(event.model), hiddenModels),
      ].filter(([label]) => hiddenModels.has(label)),
    ),
    'model',
    KEPT_MODEL_LABELS,
  );
  const modelLabel = (model: string | undefined) => {
    const label = toShareModelLabel(model);

    if (!redact || KEPT_MODEL_LABELS.has(label)) {
      return label;
    }

    if (model !== undefined && isHiddenModel(model)) {
      hiddenModels.add(label);
    }

    return hiddenModels.has(label) ? redactModel(label) : label;
  };

  const payload = measureRuntimeProfileStageSync(runtimeProfile, 'share.payload', () =>
    buildSharePayload({
      events: windowEvents,
      costs: pickCosts(costs, inWindow),
      timezone,
      sourceOrder,
      projectLabel: (repoRoot) => projectLabelForKey(toProjectKey(repoRoot)),
      machineLabel,
      modelLabel,
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
      models: [...new Set(modelFilter.map(modelLabel))].sort(),
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

  if (!request.envelope && !redact) {
    if (pricingWarning) {
      logger.warn(pricingWarning);
    }

    return { data };
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

  // Names free text may hold, as this file shows them.
  const listNames = () => {
    const names = new Map(
      [...commandLabels].map(([key, label]) => [label, projectLabelForKey(key)] as const),
    );

    if (redact) {
      for (const label of shareLabels.values()) {
        names.set(label, redactProject(label));
      }

      for (const label of hiddenModels) {
        names.set(label, redactModel(label));
      }

      for (const machine of [
        ...windowEvents.map((event) => event.machine ?? LOCAL_MACHINE_NAME),
        ...machineFilter,
      ]) {
        names.set(machine, machineLabel(machine));
      }
    }

    return names;
  };

  const envelopeData = request.envelope && {
    envelope: sanitizeEmbeddedEnvelope(request.envelope, {
      projectLabelForKey: (key) => (shareLabels.has(key) ? projectLabelForKey(key) : undefined),
      projectLabelForLabel: (label) =>
        keyByCommandLabel.has(label)
          ? projectLabelForKey(keyByCommandLabel.get(label))
          : redact
            ? redactProject(label)
            : undefined,
      machineLabel,
      modelLabel,
      scrub: createPathScrubber(pathReplacements),
      names: listNames(),
    }),
  };

  /** Built after the envelope, which may name models (optimize candidates) the events do not. */
  const createLogScrubber = (): ((message: string) => string) => {
    // Hidden models go first, by label and as logged: their names may hold a `/` the path
    // pass would split.
    const loggedModels = [...allEvents.map((event) => event.model), ...modelFilter].filter(
      (model): model is string => model !== undefined && hiddenModels.has(toShareModelLabel(model)),
    );
    const replaceModels = createNameReplacer(
      new Map(
        [...hiddenModels, ...loggedModels].map((model) => [
          model,
          redactModel(toShareModelLabel(model)),
        ]),
      ),
    );
    // Known repository roots keep their labels; any other input path is `<path>` whole.
    const inputPaths = listInputPaths(
      configuredOptions,
      userConfigResolution.loadedConfig.path,
      request.inputPaths ?? [],
    );
    const scrubPaths = createPathScrubber(
      new Map([...inputPaths.map((input) => [input, '<path>'] as const), ...pathReplacements]),
      {
        otherPath: () => '<path>',
        text: true,
      },
    );
    const replaceNames = createNameReplacer(listNames());

    return (message) => replaceNames(scrubPaths(replaceModels(message)));
  };

  const scrubLog = redact ? createLogScrubber() : undefined;

  withLogScrubber(scrubLog, () => {
    if (pricingWarning) {
      logger.warn(pricingWarning);
    }
  });

  return { data: { ...data, ...envelopeData }, scrubLog };
}
