import { toRankedModelUsage } from '../aggregate/aggregate-usage.js';
import type { ModelUsageBreakdown, UsageTotals } from '../domain/usage-report-row.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { addUsd, roundUsd } from '../utils/usd-math.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Length of an estimated usage block. */
export const BLOCK_HOURS = 5;
export const BLOCK_DURATION_MS = BLOCK_HOURS * HOUR_MS;

/**
 * One estimated 5-hour block of one source. It starts at the UTC hour floor of its first
 * event and ends exactly 5 h later (exclusive).
 */
export type UsageBlock = UsageTotals & {
  source: string;
  start: string;
  end: string;
  /** True when usage before the analysed range may have started the chain earlier. */
  startUncertain: boolean;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export type AggregateBlocksOptions = {
  /** Blocks ending at or before this instant are dropped. Undefined: keep every block. */
  sinceMs?: number;
  /**
   * The instant the events start from (the lookback start); undefined when they hold the
   * full history. Without a gap of 5 h or more after it, the chain start is uncertain.
   */
  rangeStartMs?: number;
  /** Order of sources for blocks that start at the same instant. */
  sourceOrder?: readonly string[];
  /**
   * The whole stream of each source, when `events` were narrowed (by project, model,
   * provider or machine): these events start and extend blocks but are not counted, so the
   * blocks keep the account's windows. It may hold `events` too. A block with none of
   * `events` is left out.
   */
  contextEvents?: readonly UsageEvent[];
};

type TimedEvent = {
  event: UsageEvent;
  timeMs: number;
  /** False for a context event, which only places blocks. */
  counted: boolean;
};

type BlockAccumulator = {
  source: string;
  startMs: number;
  startUncertain: boolean;
  events: TimedEvent[];
};

function toTimedEvents(
  events: readonly UsageEvent[],
  contextEvents: readonly UsageEvent[] | undefined,
): Map<string, TimedEvent[]> {
  const bySource = new Map<string, TimedEvent[]>();
  const add = (event: UsageEvent, counted: boolean) => {
    const timed = { event, timeMs: Date.parse(event.timestamp), counted };
    const sourceEvents = bySource.get(event.source);

    if (sourceEvents) {
      sourceEvents.push(timed);
    } else if (counted) {
      bySource.set(event.source, [timed]);
    }
  };

  for (const event of events) {
    add(event, true);
  }

  // After the counted events, so only the sources they have get a stream.
  for (const event of contextEvents ?? []) {
    add(event, false);
  }

  for (const sourceEvents of bySource.values()) {
    sourceEvents.sort((left, right) => left.timeMs - right.timeMs);
  }

  return bySource;
}

/**
 * Index of the first event the chain can start from without changing any kept block: the
 * last one that follows a gap of 5 h or more and is at or before `sinceMs`. The block of
 * the event before such a gap ends by the gap's end, so it is dropped anyway.
 */
function findChainStart(
  sourceEvents: readonly TimedEvent[],
  options: AggregateBlocksOptions,
): { index: number; certain: boolean } {
  const { sinceMs, rangeStartMs } = options;

  if (sinceMs !== undefined) {
    for (let index = sourceEvents.length - 1; index > 0; index -= 1) {
      const current = sourceEvents[index];

      if (
        current.timeMs <= sinceMs &&
        current.timeMs - sourceEvents[index - 1].timeMs >= BLOCK_DURATION_MS
      ) {
        return { index, certain: true };
      }
    }
  }

  // No event in the 5 h after the range start: anything earlier ended before the first one.
  const certain =
    rangeStartMs === undefined || sourceEvents[0].timeMs - rangeStartMs >= BLOCK_DURATION_MS;

  return { index: 0, certain };
}

function chainSourceBlocks(
  source: string,
  sourceEvents: readonly TimedEvent[],
  options: AggregateBlocksOptions,
): BlockAccumulator[] {
  const chainStart = findChainStart(sourceEvents, options);
  const blocks: BlockAccumulator[] = [];
  let uncertain = !chainStart.certain;
  let current: BlockAccumulator | undefined;

  for (let index = chainStart.index; index < sourceEvents.length; index += 1) {
    const timed = sourceEvents[index];

    // A gap of 5 h or more ends whatever block came before, so alignment is known again.
    if (
      index > chainStart.index &&
      timed.timeMs - sourceEvents[index - 1].timeMs >= BLOCK_DURATION_MS
    ) {
      uncertain = false;
    }

    if (!current || timed.timeMs >= current.startMs + BLOCK_DURATION_MS) {
      current = {
        source,
        startMs: Math.floor(timed.timeMs / HOUR_MS) * HOUR_MS,
        startUncertain: uncertain,
        events: [],
      };
      blocks.push(current);
    }

    if (timed.counted) {
      current.events.push(timed);
    }
  }

  const sinceMs = options.sinceMs;
  return blocks.filter(
    (block) =>
      block.events.length > 0 &&
      (sinceMs === undefined || block.startMs + BLOCK_DURATION_MS > sinceMs),
  );
}

function createEmptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function addEventToTotals(target: UsageTotals, event: UsageEvent): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.totalTokens += event.totalTokens;

  if (event.costUsd === undefined) {
    target.costIncomplete = true;
    return;
  }

  target.costUsd = addUsd(target.costUsd ?? 0, event.costUsd);
}

function toUsageBlock(block: BlockAccumulator): UsageBlock {
  const totals = createEmptyTotals();
  const modelTotals = new Map<string, UsageTotals>();

  for (const { event } of block.events) {
    addEventToTotals(totals, event);
    const model = event.model?.trim().toLowerCase();

    if (model) {
      const totalsForModel = modelTotals.get(model) ?? createEmptyTotals();
      addEventToTotals(totalsForModel, event);
      modelTotals.set(model, totalsForModel);
    }
  }

  return {
    source: block.source,
    start: new Date(block.startMs).toISOString(),
    end: new Date(block.startMs + BLOCK_DURATION_MS).toISOString(),
    startUncertain: block.startUncertain,
    firstEventAt: new Date(block.events[0].timeMs).toISOString(),
    lastEventAt: new Date(block.events[block.events.length - 1].timeMs).toISOString(),
    eventCount: block.events.length,
    ...totals,
    ...toRankedModelUsage(modelTotals),
  };
}

function compareSources(sourceOrder: readonly string[]): (left: string, right: string) => number {
  const rank = (source: string) => {
    const index = sourceOrder.indexOf(source);
    return index === -1 ? sourceOrder.length : index;
  };

  return (left, right) => {
    const byRank = rank(left) - rank(right);
    return byRank === 0 ? compareByCodePoint(left, right) : byRank;
  };
}

/**
 * Estimated 5-hour blocks, one chain per source across every machine, ordered by start and
 * then by `sourceOrder`. Events must already be priced and filtered; see `contextEvents`
 * for events narrowed below the whole stream.
 */
export function aggregateBlocks(
  events: readonly UsageEvent[],
  options: AggregateBlocksOptions = {},
): UsageBlock[] {
  const compare = compareSources(options.sourceOrder ?? []);
  const blocks: BlockAccumulator[] = [];

  for (const [source, sourceEvents] of toTimedEvents(events, options.contextEvents)) {
    blocks.push(...chainSourceBlocks(source, sourceEvents, options));
  }

  return blocks
    .sort((left, right) =>
      left.startMs === right.startMs
        ? compare(left.source, right.source)
        : left.startMs - right.startMs,
    )
    .map(toUsageBlock);
}

export type BlockBurnRate = {
  /** Remaining whole minutes until the block ends, rounded up. */
  remainingMinutes: number;
  tokensPerHour: number;
  /** Undefined when no event of the block has a cost. */
  costUsdPerHour?: number;
  /** The block's cost is incomplete, so the cost rate is a lower bound. */
  costIncomplete?: boolean;
};

export function isBlockActive(block: UsageBlock, nowMs: number): boolean {
  return Date.parse(block.start) <= nowMs && nowMs < Date.parse(block.end);
}

/** Usage per hour since the block started, counting at least one minute. */
export function computeBurnRate(block: UsageBlock, nowMs: number): BlockBurnRate {
  const elapsedHours = Math.max(nowMs - Date.parse(block.start), MINUTE_MS) / HOUR_MS;

  return {
    remainingMinutes: Math.ceil((Date.parse(block.end) - nowMs) / MINUTE_MS),
    tokensPerHour: Math.round(block.totalTokens / elapsedHours),
    ...(block.costUsd === undefined
      ? {}
      : { costUsdPerHour: roundUsd(block.costUsd / elapsedHours) }),
    ...(block.costIncomplete ? { costIncomplete: true } : {}),
  };
}

export type BlockRanking = 'cost' | 'tokens';

/** Cost ranks blocks unless cost is hidden or any block's cost is incomplete. */
export function resolveBlockRanking(
  blocks: readonly UsageBlock[],
  options: { hideCost?: boolean } = {},
): BlockRanking {
  if (options.hideCost) {
    return 'tokens';
  }

  return blocks.some((block) => block.costIncomplete === true || block.costUsd === undefined)
    ? 'tokens'
    : 'cost';
}

/** The `top` blocks across sources by `ranking`, ties by start; keeps the input order otherwise. */
export function selectTopBlocks<Block extends UsageBlock>(
  blocks: readonly Block[],
  top: number,
  ranking: BlockRanking,
): Block[] {
  const value = (block: Block) => (ranking === 'cost' ? (block.costUsd ?? 0) : block.totalTokens);

  return blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) =>
      value(left.block) === value(right.block)
        ? left.index - right.index
        : value(right.block) - value(left.block),
    )
    .slice(0, top)
    .map(({ block }) => block);
}

/** The key `findEventBlockKey` matches: a block's source and start. */
export function toBlockKey(block: Pick<UsageBlock, 'source' | 'start'>): string {
  return `${block.source}\0${String(Date.parse(block.start))}`;
}

/**
 * The key of the block an event lies in, among `blockKeys` (from `toBlockKey`). Blocks of
 * one source never overlap and start on an hour, so it is the one starting in the event's
 * hour or the 4 before.
 */
export function findEventBlockKey(
  event: Pick<UsageEvent, 'source' | 'timestamp'>,
  blockKeys: { has(key: string): boolean },
): string | undefined {
  const hourMs = Math.floor(Date.parse(event.timestamp) / HOUR_MS) * HOUR_MS;

  for (let startMs = hourMs; startMs > hourMs - BLOCK_DURATION_MS; startMs -= HOUR_MS) {
    const key = `${event.source}\0${String(startMs)}`;

    if (blockKeys.has(key)) {
      return key;
    }
  }

  return undefined;
}
