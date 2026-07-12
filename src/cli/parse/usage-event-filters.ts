import { matchesCanonicalProviderFilter } from '../../domain/provider-normalization.js';
import type { UsageEvent } from '../../domain/usage-event.js';
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

function collectProviderAndDateFilteredEvents(
  eventGroups: Iterable<readonly UsageEvent[]>,
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const filteredEvents: UsageEvent[] = [];
  const hasDateRange = Boolean(options.since ?? options.until);
  const dateByTimestamp = new Map<string, string>();

  for (const events of eventGroups) {
    for (const event of events) {
      if (!matchesCanonicalProviderFilter(event.provider, options.providerFilter)) {
        continue;
      }

      if (hasDateRange) {
        let eventDate = dateByTimestamp.get(event.timestamp);

        if (!eventDate) {
          eventDate = getPeriodKey(event.timestamp, 'daily', options.timezone);
          dateByTimestamp.set(event.timestamp, eventDate);
        }

        if (!isEventWithinDateRange(eventDate, options.since, options.until)) {
          continue;
        }
      }

      filteredEvents.push(event);
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
