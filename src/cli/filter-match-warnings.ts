import { normalizeProviderToBillingEntity } from '../domain/provider-normalization.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { suggestClosest } from '../utils/suggest-closest.js';
import type { AdapterParseResult } from './build-usage-data-parsing.js';
import { filterUsageEvents } from './parse/usage-event-filters.js';

export type FilterMatchInput = {
  parseResults: readonly AdapterParseResult[];
  /** Sources named with --source on the command line; config `sources` never warn. */
  cliSourceFilter?: ReadonlySet<string>;
  /** The --provider value as typed. */
  provider?: string;
  /** Normalized --model values. */
  modelFilter?: readonly string[];
  timezone: string;
  since?: string;
  until?: string;
};

function formatSuggestion(input: string, candidates: readonly string[]): string {
  const suggestion = suggestClosest(input, candidates);
  return suggestion ? ` (did you mean ${suggestion}?)` : '';
}

function collectSortedValues(
  events: readonly UsageEvent[],
  select: (event: UsageEvent) => string | undefined,
): string[] {
  const values = new Set<string>();

  for (const event of events) {
    const value = select(event);

    if (value) {
      values.add(value);
    }
  }

  return [...values].sort(compareByCodePoint);
}

/** Matches the report's model rule: exact name when one exists, otherwise a substring. */
function modelValueMatches(value: string, models: readonly string[]): boolean {
  return models.some((model) => model === value || model.includes(value));
}

function findUnmatchedModelWarnings(
  events: readonly UsageEvent[],
  modelFilter: readonly string[] | undefined,
  scope: string,
): string[] {
  if (!modelFilter || modelFilter.length === 0) {
    return [];
  }

  const models = collectSortedValues(events, (event) => event.model?.toLowerCase());

  return modelFilter
    .filter((value) => !modelValueMatches(value, models))
    .map((value) => `--model ${value} matched no usage${scope}${formatSuggestion(value, models)}`);
}

function findUnmatchedProviderWarning(
  events: readonly UsageEvent[],
  provider: string | undefined,
  scope: string,
): string[] {
  const normalizedFilter = normalizeProviderToBillingEntity(provider);

  if (!provider || !normalizedFilter) {
    return [];
  }

  const providers = collectSortedValues(events, (event) =>
    normalizeProviderToBillingEntity(event.provider),
  );

  if (providers.some((candidate) => candidate.includes(normalizedFilter))) {
    return [];
  }

  return [
    `--provider ${provider} matched no usage${scope}${formatSuggestion(normalizedFilter, providers)}`,
  ];
}

function findSourcesWithoutFiles(
  parseResults: readonly AdapterParseResult[],
  cliSourceFilter: ReadonlySet<string> | undefined,
): string[] {
  if (!cliSourceFilter) {
    return [];
  }

  return parseResults
    .filter((result) => cliSourceFilter.has(result.source.toLowerCase()) && result.filesFound === 0)
    .map(
      (result) =>
        `--source ${result.source} found no files; \`llm-usage doctor --source ${result.source}\` shows where it looks`,
    );
}

/**
 * Warnings for filters that cannot match: a --model or --provider value absent from every
 * parsed event in the report's date range, and a --source with no files. When no source
 * has files at all, the "No session files found" warning already says so.
 */
export function findUnmatchedFilterWarnings(input: FilterMatchInput): string[] {
  if (!input.parseResults.some((result) => result.filesFound > 0)) {
    return [];
  }

  // Judged within the date range, so the answer does not depend on which files a
  // `--since` run skipped by modification time.
  const eventsInRange = filterUsageEvents(
    input.parseResults.flatMap((result) => result.events),
    { timezone: input.timezone, since: input.since, until: input.until },
  );
  const scope = input.since !== undefined || input.until !== undefined ? ' in this date range' : '';

  return [
    ...findSourcesWithoutFiles(input.parseResults, input.cliSourceFilter),
    ...findUnmatchedProviderWarning(eventsInRange, input.provider, scope),
    ...findUnmatchedModelWarnings(eventsInRange, input.modelFilter, scope),
  ];
}
