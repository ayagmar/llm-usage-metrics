import { IDLE_GAP_CAP_MS } from '../domain/active-time.js';
import { getEventSessionKey, LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import type { UsageBlock } from '../blocks/aggregate-blocks.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getLocalHourBucket, getPeriodKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { addUsd } from '../utils/usd-math.js';
import { escapeJsonForScript } from './client/ui/export/share-document.js';
import { toShareModelLabel } from './redact.js';
import type {
  ShareBlock,
  ShareBlocks,
  ShareCostMode,
  ShareCosts,
  ShareCube,
  ShareDictionaries,
  ShareSession,
  ShareSessions,
  ShareTokenBuckets,
} from './types.js';

const HOUR_MS = 60 * 60 * 1000;

/** Every cost mode, in the order the file lists them. */
export const SHARE_COST_MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];

/** The newest sessions embedded per project; older ones are counted in `sessions.omitted`. */
export const SESSIONS_PER_PROJECT = 200;

/** The HTML file should stay under this many bytes. */
export const SHARE_HTML_TARGET_BYTES = 8_000_000;

/** What the page itself (script, style, markup) takes from the HTML target. */
const PAGE_ALLOWANCE_BYTES = 500_000;

/** Over the target, cells older than this many days before the window end become daily. */
export const HOURLY_DETAIL_DAYS = 90;

/** Each event's cost per available mode, aligned with the events; undefined where it has none. */
export type ShareEventCosts = Partial<Record<ShareCostMode, readonly (number | undefined)[]>>;

export type SharePayloadInput = {
  /** The window's events (no lookback), in dataset order. */
  events: readonly UsageEvent[];
  costs: ShareEventCosts;
  timezone: string;
  /** Source order of the dictionary, the adapters' order; other sources follow by name. */
  sourceOrder: readonly string[];
  /** The file's label (redacted with --redact) of an event's `repoRoot`. */
  projectLabel: (repoRoot: string | undefined) => string;
  /** The file's label (redacted with --redact) of a machine name. */
  machineLabel: (machine: string) => string;
  /** The blocks command's blocks over `blockEvents`, which include the lookback. */
  blocks: readonly UsageBlock[];
  blockEvents: readonly UsageEvent[];
  blockCosts: ShareEventCosts;
  blockHours: number;
  /** Last local date of the window, where the 90 days of hourly detail end. */
  windowEnd: string;
  /** Payload bytes above which older cells roll up to days. */
  targetBytes?: number;
  sessionsPerProject?: number;
};

export type SharePayload = {
  dictionaries: ShareDictionaries;
  cube: ShareCube;
  sessions: ShareSessions;
  blocks: ShareBlocks;
  /** First local date with hourly cells; null when every cell is hourly. */
  hourlyFrom: string | null;
  /** JSON bytes of the four parts above. */
  bytes: number;
};

type ModeTotals = { costUsd: number | undefined; incompleteEvents: number };

type CostAccumulator = Partial<Record<ShareCostMode, ModeTotals>>;

type TokenAccumulator = ShareTokenBuckets & { eventCount: number };

type Cell = TokenAccumulator & {
  period: number;
  source: number;
  model: number;
  project: number;
  machine: number;
  activeMs: number;
  costs: CostAccumulator;
};

/** One event's dimensions, as labels. */
type EventDims = {
  source: string;
  model: string;
  project: string;
  machine: string;
};

function createTokens(): TokenAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    eventCount: 0,
  };
}

function addTokens(target: TokenAccumulator, event: UsageEvent): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.totalTokens += event.totalTokens;
  target.eventCount += 1;
}

function createCosts(modes: readonly ShareCostMode[]): CostAccumulator {
  const costs: CostAccumulator = {};

  for (const mode of modes) {
    costs[mode] = { costUsd: undefined, incompleteEvents: 0 };
  }

  return costs;
}

/** Adds an event's cost per mode as the reports do: `addUsd`, and no cost counts as incomplete. */
function addCosts(target: CostAccumulator, costs: ShareEventCosts, index: number): void {
  for (const mode of SHARE_COST_MODES) {
    const totals = target[mode];
    const eventCosts = costs[mode];

    if (!totals || !eventCosts) {
      continue;
    }

    const cost = eventCosts[index];

    if (cost === undefined) {
      totals.incompleteEvents += 1;
    } else {
      totals.costUsd = addUsd(totals.costUsd ?? 0, cost);
    }
  }
}

function toShareCosts(costs: CostAccumulator): ShareCosts {
  const shared: ShareCosts = {};

  for (const mode of SHARE_COST_MODES) {
    const totals = costs[mode];

    if (totals) {
      shared[mode] = { costUsd: totals.costUsd ?? null, incompleteEvents: totals.incompleteEvents };
    }
  }

  return shared;
}

function toTokenBuckets(tokens: ShareTokenBuckets): ShareTokenBuckets {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    reasoningTokens: tokens.reasoningTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    totalTokens: tokens.totalTokens,
  };
}

function availableModes(costs: ShareEventCosts): ShareCostMode[] {
  return SHARE_COST_MODES.filter((mode) => costs[mode] !== undefined);
}

/** Index of each label in a sorted dictionary. */
function indexLabels(labels: readonly string[]): Map<string, number> {
  return new Map(labels.map((label, index) => [label, index]));
}

function rankByTokens(tokensByLabel: ReadonlyMap<string, number>): string[] {
  return [...tokensByLabel.entries()]
    .sort(([leftLabel, leftTokens], [rightLabel, rightTokens]) =>
      leftTokens === rightTokens
        ? compareByCodePoint(leftLabel, rightLabel)
        : rightTokens - leftTokens,
    )
    .map(([label]) => label);
}

function orderSources(sources: ReadonlySet<string>, sourceOrder: readonly string[]): string[] {
  const rank = (source: string) => {
    const index = sourceOrder.indexOf(source);
    return index === -1 ? sourceOrder.length : index;
  };

  return [...sources].sort(
    (left, right) => rank(left) - rank(right) || compareByCodePoint(left, right),
  );
}

type Dictionaries = {
  labels: Omit<ShareDictionaries, 'periods'>;
  source: Map<string, number>;
  model: Map<string, number>;
  project: Map<string, number>;
  machine: Map<string, number>;
};

function buildDictionaries(input: SharePayloadInput, dims: readonly EventDims[]): Dictionaries {
  const sources = new Set<string>();
  const models = new Set<string>();
  const projectTokens = new Map<string, number>();
  const machineTokens = new Map<string, number>();

  input.events.forEach((event, index) => {
    const eventDims = dims[index];
    sources.add(eventDims.source);
    models.add(eventDims.model);
    projectTokens.set(
      eventDims.project,
      (projectTokens.get(eventDims.project) ?? 0) + event.totalTokens,
    );
    machineTokens.set(
      eventDims.machine,
      (machineTokens.get(eventDims.machine) ?? 0) + event.totalTokens,
    );
  });

  for (const block of input.blocks) {
    sources.add(block.source);

    for (const model of block.models) {
      models.add(toShareModelLabel(model));
    }
  }

  const labels = {
    sources: orderSources(sources, input.sourceOrder),
    models: [...models].sort(compareByCodePoint),
    projects: rankByTokens(projectTokens),
    machines: rankByTokens(machineTokens),
  };

  return {
    labels,
    source: indexLabels(labels.sources),
    model: indexLabels(labels.models),
    project: indexLabels(labels.projects),
    machine: indexLabels(labels.machines),
  };
}

function lookup(index: ReadonlyMap<string, number>, label: string): number {
  const value = index.get(label);

  if (value === undefined) {
    throw new Error(`share report: no dictionary entry for ${label}`);
  }

  return value;
}

type SessionAccumulator = TokenAccumulator & {
  source: string;
  repoRoot: string | undefined;
  firstMs: number;
  lastMs: number;
  machines: Set<string>;
  models: Set<string>;
  costs: CostAccumulator;
  /** Each event's time and cell, for active time. */
  timeline: { timeMs: number; cell: Cell }[];
  activeMs: number;
};

type CubeBuild = {
  periods: string[];
  cells: Cell[];
  sessions: SessionAccumulator[];
};

/**
 * Cells by (period, source, model, project, machine), and the sessions as `aggregate-sessions`
 * keys them. Each capped gap between a session's consecutive events counts in the cell of the
 * later one, so active time sums to the session's over any dimension.
 */
function buildCube(
  input: SharePayloadInput,
  dims: readonly EventDims[],
  dictionaries: Dictionaries,
  hourlyFrom: string | null,
  modes: readonly ShareCostMode[],
): CubeBuild {
  const periodIndex = new Map<string, number>();
  const cellsByKey = new Map<string, Cell>();
  const sessions = new Map<string, SessionAccumulator>();

  input.events.forEach((event, index) => {
    const eventDims = dims[index];
    const dayKey = getPeriodKey(event.timestamp, 'daily', input.timezone);
    const periodKey =
      hourlyFrom !== null && dayKey < hourlyFrom
        ? dayKey
        : getPeriodKey(event.timestamp, 'hourly', input.timezone);
    let period = periodIndex.get(periodKey);

    if (period === undefined) {
      period = periodIndex.size;
      periodIndex.set(periodKey, period);
    }

    const source = lookup(dictionaries.source, eventDims.source);
    const model = lookup(dictionaries.model, eventDims.model);
    const project = lookup(dictionaries.project, eventDims.project);
    const machine = lookup(dictionaries.machine, eventDims.machine);
    const cellKey = `${String(period)},${String(source)},${String(model)},${String(project)},${String(machine)}`;
    let cell = cellsByKey.get(cellKey);

    if (!cell) {
      cell = {
        ...createTokens(),
        period,
        source,
        model,
        project,
        machine,
        activeMs: 0,
        costs: createCosts(modes),
      };
      cellsByKey.set(cellKey, cell);
    }

    addTokens(cell, event);
    addCosts(cell.costs, input.costs, index);

    const timeMs = Date.parse(event.timestamp);
    const sessionKey = getEventSessionKey(event);
    let session = sessions.get(sessionKey);

    if (!session) {
      session = {
        ...createTokens(),
        source: event.source,
        repoRoot: undefined,
        firstMs: timeMs,
        lastMs: timeMs,
        machines: new Set(),
        models: new Set(),
        costs: createCosts(modes),
        timeline: [],
        activeMs: 0,
      };
      sessions.set(sessionKey, session);
    }

    addTokens(session, event);
    addCosts(session.costs, input.costs, index);
    // As `aggregate-sessions`: the first root seen in event order.
    session.repoRoot ??= event.repoRoot;
    session.firstMs = Math.min(session.firstMs, timeMs);
    session.lastMs = Math.max(session.lastMs, timeMs);
    session.machines.add(eventDims.machine);
    session.models.add(eventDims.model);
    session.timeline.push({ timeMs, cell });
  });

  for (const session of sessions.values()) {
    session.timeline.sort((left, right) => left.timeMs - right.timeMs);

    for (let index = 1; index < session.timeline.length; index += 1) {
      const later = session.timeline[index];
      const gapMs = Math.min(later.timeMs - session.timeline[index - 1].timeMs, IDLE_GAP_CAP_MS);
      later.cell.activeMs += gapMs;
      session.activeMs += gapMs;
    }

    session.timeline = [];
  }

  // Cells in period order; dictionary indices otherwise. Periods are re-indexed sorted.
  const periods = [...periodIndex.keys()].sort(compareByCodePoint);
  const sortedIndex = indexLabels(periods);
  const sortedPeriod = new Map(
    [...periodIndex.entries()].map(([key, index]) => [index, lookup(sortedIndex, key)]),
  );
  const cells = [...cellsByKey.values()];

  for (const cell of cells) {
    cell.period = sortedPeriod.get(cell.period) ?? cell.period;
  }

  cells.sort(
    (left, right) =>
      left.period - right.period ||
      left.source - right.source ||
      left.model - right.model ||
      left.project - right.project ||
      left.machine - right.machine,
  );

  return { periods, cells, sessions: [...sessions.values()] };
}

function toCube(cells: readonly Cell[], modes: readonly ShareCostMode[]): ShareCube {
  const cube: ShareCube = {
    period: [],
    source: [],
    model: [],
    project: [],
    machine: [],
    inputTokens: [],
    outputTokens: [],
    reasoningTokens: [],
    cacheReadTokens: [],
    cacheWriteTokens: [],
    totalTokens: [],
    eventCount: [],
    activeMs: [],
    costs: {},
  };

  for (const mode of modes) {
    cube.costs[mode] = { costUsd: [], incompleteEvents: [] };
  }

  for (const cell of cells) {
    cube.period.push(cell.period);
    cube.source.push(cell.source);
    cube.model.push(cell.model);
    cube.project.push(cell.project);
    cube.machine.push(cell.machine);
    cube.inputTokens.push(cell.inputTokens);
    cube.outputTokens.push(cell.outputTokens);
    cube.reasoningTokens.push(cell.reasoningTokens);
    cube.cacheReadTokens.push(cell.cacheReadTokens);
    cube.cacheWriteTokens.push(cell.cacheWriteTokens);
    cube.totalTokens.push(cell.totalTokens);
    cube.eventCount.push(cell.eventCount);
    cube.activeMs.push(cell.activeMs);

    for (const mode of modes) {
      const totals = cell.costs[mode];
      cube.costs[mode]?.costUsd.push(totals?.costUsd ?? null);
      cube.costs[mode]?.incompleteEvents.push(totals?.incompleteEvents ?? 0);
    }
  }

  return cube;
}

/** `YYYY-MM-DD HH:MM` on the local wall clock. */
function formatLocalMinute(timeMs: number, timezone: string): string {
  const iso = new Date(timeMs).toISOString();
  const wallMs = timeMs + getLocalHourBucket(iso, timezone).offsetMs;
  return new Date(wallMs).toISOString().slice(0, 16).replace('T', ' ');
}

function compareNewestFirst(left: SessionAccumulator, right: SessionAccumulator): number {
  return right.lastMs - left.lastMs || right.firstMs - left.firstMs;
}

function buildSessions(
  input: SharePayloadInput,
  sessions: SessionAccumulator[],
  dictionaries: Dictionaries,
): ShareSessions {
  const cap = input.sessionsPerProject ?? SESSIONS_PER_PROJECT;
  const byProject = new Map<string, SessionAccumulator[]>();

  for (const session of sessions.sort(compareNewestFirst)) {
    const project = input.projectLabel(session.repoRoot);
    const projectSessions = byProject.get(project);

    if (projectSessions) {
      projectSessions.push(session);
    } else {
      byProject.set(project, [session]);
    }
  }

  const kept: { session: SessionAccumulator; project: string }[] = [];
  const omitted: ShareSessions['omitted'] = [];

  for (const [project, projectSessions] of byProject) {
    kept.push(...projectSessions.slice(0, cap).map((session) => ({ session, project })));

    if (projectSessions.length > cap) {
      omitted.push({
        project: lookup(dictionaries.project, project),
        count: projectSessions.length - cap,
      });
    }
  }

  kept.sort((left, right) => compareNewestFirst(left.session, right.session));
  omitted.sort((left, right) => left.project - right.project);

  // `#n` on equal labels, numbered from the earliest start.
  const labelCounts = new Map<string, number>();
  const labels = new Map<SessionAccumulator, string>();

  for (const { session } of [...kept].sort(
    (left, right) =>
      left.session.firstMs - right.session.firstMs || left.session.lastMs - right.session.lastMs,
  )) {
    const base = `${session.source} · ${formatLocalMinute(session.firstMs, input.timezone)}`;
    const count = (labelCounts.get(base) ?? 0) + 1;
    labelCounts.set(base, count);
    labels.set(session, count === 1 ? base : `${base} #${String(count)}`);
  }

  const rows: ShareSession[] = kept.map(({ session, project }) => ({
    label: labels.get(session) ?? session.source,
    source: lookup(dictionaries.source, session.source),
    project: lookup(dictionaries.project, project),
    machines: [...session.machines]
      .map((machine) => lookup(dictionaries.machine, machine))
      .sort((left, right) => left - right),
    firstActivityAt: new Date(session.firstMs).toISOString(),
    lastActivityAt: new Date(session.lastMs).toISOString(),
    eventCount: session.eventCount,
    activeMs: session.activeMs,
    models: [...session.models]
      .map((model) => lookup(dictionaries.model, model))
      .sort((left, right) => left - right),
    ...toTokenBuckets(session),
    costs: toShareCosts(session.costs),
  }));

  return { rows, omitted };
}

/**
 * The blocks with a cost per mode. Blocks of one source never overlap, so each counted event
 * lies in at most one, found from its hour back to 5 h earlier.
 */
function buildBlocks(
  input: SharePayloadInput,
  dictionaries: Dictionaries,
  modes: readonly ShareCostMode[],
): ShareBlocks {
  const blockDurationMs = input.blockHours * HOUR_MS;
  const costsByBlock = new Map<string, CostAccumulator>();

  for (const block of input.blocks) {
    costsByBlock.set(`${block.source}\0${String(Date.parse(block.start))}`, createCosts(modes));
  }

  input.blockEvents.forEach((event, index) => {
    const timeMs = Date.parse(event.timestamp);
    const hourMs = Math.floor(timeMs / HOUR_MS) * HOUR_MS;

    for (let startMs = hourMs; startMs > timeMs - blockDurationMs; startMs -= HOUR_MS) {
      const costs = costsByBlock.get(`${event.source}\0${String(startMs)}`);

      if (costs) {
        addCosts(costs, input.blockCosts, index);
        return;
      }
    }
  });

  const rows: ShareBlock[] = input.blocks.map((block) => ({
    source: lookup(dictionaries.source, block.source),
    start: block.start,
    end: block.end,
    startUncertain: block.startUncertain,
    firstEventAt: block.firstEventAt,
    lastEventAt: block.lastEventAt,
    eventCount: block.eventCount,
    models: [
      ...new Set(block.models.map((model) => lookup(dictionaries.model, toShareModelLabel(model)))),
    ],
    ...toTokenBuckets(block),
    costs: toShareCosts(
      costsByBlock.get(`${block.source}\0${String(Date.parse(block.start))}`) ?? {},
    ),
  }));

  return { blockHours: input.blockHours, rows };
}

function assemble(
  input: SharePayloadInput,
  dims: readonly EventDims[],
  dictionaries: Dictionaries,
  hourlyFrom: string | null,
  blocks: ShareBlocks,
): SharePayload {
  const modes = availableModes(input.costs);
  const build = buildCube(input, dims, dictionaries, hourlyFrom, modes);
  const parts = {
    dictionaries: { periods: build.periods, ...dictionaries.labels },
    cube: toCube(build.cells, modes),
    sessions: buildSessions(input, build.sessions, dictionaries),
    blocks,
  };

  // As the file holds it: script escaping makes some characters longer.
  const bytes = Buffer.byteLength(escapeJsonForScript(JSON.stringify(parts)));

  return { ...parts, hourlyFrom, bytes };
}

/**
 * The share payload's data parts. Every cell is hourly unless that makes the payload larger
 * than the target; then cells older than 90 days before the window end become daily, and
 * `hourlyFrom` says where hourly detail starts.
 */
export function buildSharePayload(input: SharePayloadInput): SharePayload {
  const dims: EventDims[] = input.events.map((event) => ({
    source: event.source,
    model: toShareModelLabel(event.model),
    project: input.projectLabel(event.repoRoot),
    machine: input.machineLabel(event.machine ?? LOCAL_MACHINE_NAME),
  }));
  const dictionaries = buildDictionaries(input, dims);
  const blocks = buildBlocks(input, dictionaries, availableModes(input.blockCosts));
  const hourly = assemble(input, dims, dictionaries, null, blocks);
  const targetBytes = input.targetBytes ?? SHARE_HTML_TARGET_BYTES - PAGE_ALLOWANCE_BYTES;

  if (hourly.bytes <= targetBytes) {
    return hourly;
  }

  const hourlyFrom = shiftLocalDateKey(input.windowEnd, -HOURLY_DETAIL_DAYS);
  const rollsUpAnything = input.events.some(
    (event) => getPeriodKey(event.timestamp, 'daily', input.timezone) < hourlyFrom,
  );

  return rollsUpAnything ? assemble(input, dims, dictionaries, hourlyFrom, blocks) : hourly;
}

/**
 * What stderr says about a written share file's size: where hourly detail starts when older
 * cells rolled up to days, and the size when the file is still over the target.
 */
export function listShareSizeWarnings(file: {
  hourlyFrom: string | null;
  htmlBytes: number;
}): string[] {
  const warnings: string[] = [];

  if (file.hourlyFrom !== null) {
    warnings.push(
      `Share report: hourly detail from ${file.hourlyFrom}; earlier usage is by day to keep the file small.`,
    );
  }

  if (file.htmlBytes > SHARE_HTML_TARGET_BYTES) {
    const toMegabytes = (bytes: number) => bytes / 1_000_000;
    warnings.push(
      `Share report: the file is ${toMegabytes(file.htmlBytes).toFixed(1)} MB, over the ${String(toMegabytes(SHARE_HTML_TARGET_BYTES))} MB target; a shorter window or narrower filters make it smaller.`,
    );
  }

  return warnings;
}
