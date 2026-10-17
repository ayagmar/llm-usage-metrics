import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import { estimateLongContextExtraUsd, getPromptTokens } from '../pricing/cost-engine.js';
import type { ModelPricing } from '../pricing/types.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { addUsd } from '../utils/usd-math.js';

/** A request whose prompt is above this many tokens counts as long-context. */
export const LONG_CONTEXT_PROMPT_TOKENS = 200_000;

/** A request whose prompt is above this share of its model's context limit counts as near it. */
export const NEAR_LIMIT_SHARE = 0.8;

/** Prompt sizes over a set of single-request events. */
export type ContextPressure = {
  requests: number;
  /** The largest prompt: input, cache read and cache write tokens. */
  peakPromptTokens: number;
  /** Requests with a prompt above LONG_CONTEXT_PROMPT_TOKENS. */
  longContextRequests: number;
  /** What long-context tier rates added to the estimates; absent when no request was priced. */
  longContextExtraUsd?: number;
  /** Some request had no pricing, so the extra may be low. */
  longContextExtraIncomplete?: boolean;
  /** Requests above NEAR_LIMIT_SHARE of their model's limit; absent when no limit is known. */
  nearLimitRequests?: number;
};

export type ContextModelRow = ContextPressure & {
  /** Absent for events that name no model. */
  model?: string;
  /** LiteLLM's `max_input_tokens` for the model; absent when unknown. */
  contextLimit?: number;
};

export type ContextSessionRow = ContextPressure & {
  source: string;
  sessionId: string;
  repoRoot?: string;
  models: string[];
};

/** A source whose usage records sum several requests, so it has no per-request prompt sizes. */
export type AggregatedContextSource = {
  source: string;
  records: number;
};

export type ContextPressureReport = {
  models: ContextModelRow[];
  sessions: ContextSessionRow[];
  aggregatedSources: AggregatedContextSource[];
};

export type AggregateContextPressureOptions = {
  /** Sources whose usage events each record one request. */
  perRequestSourceIds: ReadonlySet<string>;
  /** The rates the cost engine prices an event's model with; undefined when not estimated. */
  lookupPricing: (event: UsageEvent) => ModelPricing | undefined;
  /** The model's context limit in tokens; undefined when unknown. */
  getContextLimit: (model: string) => number | undefined;
};

function createPressure(): ContextPressure {
  return { requests: 0, peakPromptTokens: 0, longContextRequests: 0 };
}

function addRequest(
  pressure: ContextPressure,
  event: UsageEvent,
  contextLimit: number | undefined,
  pricing: ModelPricing | undefined,
): void {
  const promptTokens = getPromptTokens(event);

  pressure.requests++;
  pressure.peakPromptTokens = Math.max(pressure.peakPromptTokens, promptTokens);

  if (promptTokens > LONG_CONTEXT_PROMPT_TOKENS) {
    pressure.longContextRequests++;
  }

  const extraUsd = pricing ? estimateLongContextExtraUsd(event, pricing) : undefined;

  if (extraUsd === undefined) {
    pressure.longContextExtraIncomplete = true;
  } else {
    pressure.longContextExtraUsd = addUsd(pressure.longContextExtraUsd ?? 0, extraUsd);
  }

  if (contextLimit !== undefined) {
    pressure.nearLimitRequests =
      (pressure.nearLimitRequests ?? 0) + (promptTokens > contextLimit * NEAR_LIMIT_SHARE ? 1 : 0);
  }
}

/** Rows by peak prompt, largest first, then by `key`. */
function sortByPeak<Row extends ContextPressure>(
  rows: Iterable<Row>,
  key: (row: Row) => string,
): Row[] {
  return [...rows].sort(
    (left, right) =>
      right.peakPromptTokens - left.peakPromptTokens || compareByCodePoint(key(left), key(right)),
  );
}

/**
 * Prompt sizes per model and per session, from the events of per-request sources; the other
 * sources are counted in `aggregatedSources`. Rows are ordered by peak prompt, largest first.
 */
export function aggregateContextPressure(
  events: readonly UsageEvent[],
  options: AggregateContextPressureOptions,
): ContextPressureReport {
  const modelRows = new Map<string | undefined, ContextModelRow>();
  const sessionRows = new Map<string, ContextSessionRow>();
  const sessionModels = new Map<ContextSessionRow, Set<string>>();
  const aggregatedRecords = new Map<string, number>();

  for (const event of events) {
    if (!options.perRequestSourceIds.has(event.source)) {
      aggregatedRecords.set(event.source, (aggregatedRecords.get(event.source) ?? 0) + 1);
      continue;
    }

    const contextLimit =
      event.model === undefined ? undefined : options.getContextLimit(event.model);
    const pricing = options.lookupPricing(event);
    let modelRow = modelRows.get(event.model);

    if (!modelRow) {
      modelRow = {
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(contextLimit === undefined ? {} : { contextLimit }),
        ...createPressure(),
      };
      modelRows.set(event.model, modelRow);
    }

    const sessionKey = getEventSessionKey(event);
    let sessionRow = sessionRows.get(sessionKey);

    if (!sessionRow) {
      sessionRow = {
        source: event.source,
        sessionId: event.sessionId,
        models: [],
        ...createPressure(),
      };
      sessionRows.set(sessionKey, sessionRow);
      sessionModels.set(sessionRow, new Set());
    }

    sessionRow.repoRoot ??= event.repoRoot;

    if (event.model !== undefined) {
      sessionModels.get(sessionRow)?.add(event.model);
    }

    addRequest(modelRow, event, contextLimit, pricing);
    addRequest(sessionRow, event, contextLimit, pricing);
  }

  for (const [sessionRow, models] of sessionModels) {
    sessionRow.models = [...models].sort(compareByCodePoint);
  }

  return {
    models: sortByPeak(modelRows.values(), (row) => row.model ?? ''),
    sessions: sortByPeak(sessionRows.values(), getEventSessionKey),
    aggregatedSources: [...aggregatedRecords]
      .map(([source, records]) => ({ source, records }))
      .sort((left, right) => compareByCodePoint(left.source, right.source)),
  };
}
