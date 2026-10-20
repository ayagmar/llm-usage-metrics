import * as core from '@ayagmar/agent-sessions';
import { normalizeUsdCost, resolveCostMode } from '@ayagmar/agent-sessions/internal';

/** How reports and `--machine` name this machine, next to the configured ones. */
export const LOCAL_MACHINE_NAME = 'local';

/**
 * The sources whose every usage event recorded one model request before events carried
 * `singleRequest`. Events stored or exported without the flag take it from this list.
 */
export const SINGLE_REQUEST_SOURCES_BEFORE_FLAG: readonly string[] = [
  'antigravity',
  'claude',
  'gemini',
  'opencode',
  'pi',
];

export type UsageEvent = core.UsageEvent & {
  costMode: core.CostMode;

  /** The configured machine the event came from; undefined for this machine's own usage. */
  machine?: string;
};

export type UsageEventInput = core.UsageEventInput & {
  costMode?: core.CostMode;
};

export function createUsageEvent(input: UsageEventInput): UsageEvent {
  if (!core.normalizeSourceId(input.source)) {
    throw new Error('UsageEvent source must be a non-empty string');
  }

  const costMode = resolveCostMode(input.costMode, normalizeUsdCost(input.costUsd));

  return Object.assign(core.createUsageEvent(input), { costMode });
}

/** A parsed file's diagnostics as the CLI holds them: every event carries a cost mode. */
export type ParseFileDiagnostics = Omit<core.SourceParseFileDiagnostics, 'events'> & {
  events: UsageEvent[];
};

type AdapterEvent = core.UsageEvent & { costMode?: core.CostMode };

function hasCostMode(event: AdapterEvent): event is UsageEvent {
  return event.costMode !== undefined;
}

/**
 * Adapter output carries no cost mode: a cost the source logged is explicit, any other
 * is estimated by pricing later. The mode is added to the event itself, after `costUsd`,
 * since a copy of every parsed event costs memory; an event that has a mode keeps it.
 */
export function withCostMode(event: AdapterEvent): UsageEvent {
  return hasCostMode(event)
    ? event
    : Object.assign(event, { costMode: resolveCostMode(undefined, event.costUsd) });
}

export function withCostModes(diagnostics: core.SourceParseFileDiagnostics): ParseFileDiagnostics {
  return { ...diagnostics, events: diagnostics.events.map(withCostMode) };
}
