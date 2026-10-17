import { matchesCanonicalProviderFilter } from '@ayagmar/agent-sessions/internal';
import type { UsageEvent } from '../../domain/usage-event.js';
import { getUtcMidnightIso } from '../../utils/date-key.js';
import { getPeriodKey } from '../../utils/time-buckets.js';
import type { AdapterParseResult } from '../build-usage-data-parsing.js';

function isEventWithinDateRange(
  eventDate: string,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (since && eventDate < since) {
    return false;
  }

  if (until && eventDate > until) {
    return false;
  }

  return true;
}

type ModelFilterRule = {
  value: string;
  mode: 'exact' | 'substring';
};

function resolveModelFilterRules(
  events: UsageEvent[],
  modelFilter: string[] | undefined,
): ModelFilterRule[] | undefined {
  if (!modelFilter || modelFilter.length === 0) {
    return undefined;
  }

  const availableModels = new Set(
    events
      .map((event) => event.model?.toLowerCase())
      .filter((model): model is string => Boolean(model)),
  );

  return modelFilter.map((value) => ({
    value,
    mode: availableModels.has(value) ? 'exact' : 'substring',
  }));
}

function matchesModel(
  model: string | undefined,
  modelRules: ModelFilterRule[] | undefined,
): boolean {
  if (!modelRules || modelRules.length === 0) {
    return true;
  }

  if (!model) {
    return false;
  }

  const normalizedModel = model.toLowerCase();

  return modelRules.some((rule) =>
    rule.mode === 'exact' ? normalizedModel === rule.value : normalizedModel.includes(rule.value),
  );
}

export type UsageEventFilterOptions = {
  timezone: string;
  since?: string;
  until?: string;
  providerFilter?: string;
  modelFilter?: string[];
};

function filterByModelRules(events: UsageEvent[], modelFilter: string[] | undefined): UsageEvent[] {
  const modelFilterRules = resolveModelFilterRules(events, modelFilter);

  return events.filter((event) => matchesModel(event.model, modelFilterRules));
}

// A local date is less than a day away from the UTC date, so a normalized ISO timestamp
// (24 characters, compared as text) a full day inside or outside the window needs no
// time zone conversion; only timestamps near an edge are converted.
export function createDateWindowPrefilter(
  since: string | undefined,
  until: string | undefined,
): (timestamp: string) => 'inside' | 'outside' | 'near-edge' {
  const outsideBefore = since ? getUtcMidnightIso(since, -1) : undefined;
  const insideFrom = since ? getUtcMidnightIso(since, 1) : undefined;
  const insideBefore = until ? getUtcMidnightIso(until, 0) : undefined;
  const outsideFrom = until ? getUtcMidnightIso(until, 2) : undefined;

  // Near year 0 or 9999 a bound shifts into an expanded year (+010000-...), which does
  // not compare as text; every timestamp is then converted.
  if (
    [outsideBefore, insideFrom, insideBefore, outsideFrom].some(
      (bound) => bound !== undefined && bound.length !== 24,
    )
  ) {
    return () => 'near-edge';
  }

  return (timestamp) => {
    if (timestamp.length !== 24) {
      return 'near-edge';
    }

    if ((outsideBefore && timestamp < outsideBefore) || (outsideFrom && timestamp >= outsideFrom)) {
      return 'outside';
    }

    return (!insideFrom || timestamp >= insideFrom) && (!insideBefore || timestamp < insideBefore)
      ? 'inside'
      : 'near-edge';
  };
}

/**
 * Whether a timestamp's local date (in `timezone`) lies in the `since`/`until` window, both
 * YYYY-MM-DD and inclusive; true for every timestamp when neither is set. Only a timestamp
 * near an edge is converted, once per distinct value.
 */
export function createTimestampWindowFilter(
  options: Pick<UsageEventFilterOptions, 'timezone' | 'since' | 'until'>,
): (timestamp: string) => boolean {
  if (!options.since && !options.until) {
    return () => true;
  }

  const prefilterDate = createDateWindowPrefilter(options.since, options.until);
  const dateByTimestamp = new Map<string, string>();

  return (timestamp) => {
    const datePosition = prefilterDate(timestamp);

    if (datePosition !== 'near-edge') {
      return datePosition === 'inside';
    }

    let date = dateByTimestamp.get(timestamp);

    if (!date) {
      date = getPeriodKey(timestamp, 'daily', options.timezone);
      dateByTimestamp.set(timestamp, date);
    }

    return isEventWithinDateRange(date, options.since, options.until);
  };
}

function collectProviderAndDateFilteredEvents(
  eventGroups: Iterable<readonly UsageEvent[]>,
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const filteredEvents: UsageEvent[] = [];
  const isInWindow = createTimestampWindowFilter(options);

  for (const events of eventGroups) {
    for (const event of events) {
      if (
        matchesCanonicalProviderFilter(event.provider, options.providerFilter) &&
        isInWindow(event.timestamp)
      ) {
        filteredEvents.push(event);
      }
    }
  }

  return filteredEvents;
}

export function filterUsageEvents(
  events: UsageEvent[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents([events], options);
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}

export function filterParsedAdapterEvents(
  parseResults: AdapterParseResult[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents(
    parseResults.map((result) => result.events),
    options,
  );
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}
