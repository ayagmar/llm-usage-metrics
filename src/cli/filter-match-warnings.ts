import { normalizeProviderToBillingEntity } from '../domain/provider-normalization.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { suggestClosest } from '../utils/suggest-closest.js';
import type { AdapterParseResult } from './build-usage-data-parsing.js';

export type FilterMatchInput = {
  parseResults: readonly AdapterParseResult[];
  sourceFilter?: ReadonlySet<string>;
  providerFilter?: string;
  modelFilter?: readonly string[];
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
): string[] {
  if (!modelFilter || modelFilter.length === 0) {
    return [];
  }

  const models = collectSortedValues(events, (event) => event.model?.toLowerCase());

  return modelFilter
    .filter((value) => !modelValueMatches(value, models))
    .map((value) => `--model ${value} matched no usage${formatSuggestion(value, models)}`);
}

function findUnmatchedProviderWarning(
  events: readonly UsageEvent[],
  providerFilter: string | undefined,
): string[] {
  const normalizedFilter = normalizeProviderToBillingEntity(providerFilter);

  if (!providerFilter || !normalizedFilter) {
    return [];
  }

  const providers = collectSortedValues(events, (event) =>
    normalizeProviderToBillingEntity(event.provider),
  );

  if (providers.some((provider) => provider.includes(normalizedFilter))) {
    return [];
  }

  return [
    `--provider ${providerFilter} matched no usage${formatSuggestion(normalizedFilter, providers)}`,
  ];
}

/**
 * A selected source without files, while others have some. When no source has files,
 * the "No session files found" warning already covers it.
 */
function findSourcesWithoutFiles(
  parseResults: readonly AdapterParseResult[],
  sourceFilter: ReadonlySet<string> | undefined,
): string[] {
  if (!sourceFilter || !parseResults.some((result) => result.filesFound > 0)) {
    return [];
  }

  return parseResults
    .filter((result) => sourceFilter.has(result.source.toLowerCase()) && result.filesFound === 0)
    .map(
      (result) =>
        `--source ${result.source} found no files; \`llm-usage doctor --source ${result.source}\` shows where it looks`,
    );
}

/**
 * Warnings for filters that cannot match: a model or provider absent from every parsed
 * event (dates ignored, so a value used only outside the window does not warn), and a
 * selected source with no files.
 */
export function findUnmatchedFilterWarnings(input: FilterMatchInput): string[] {
  const events = input.parseResults.flatMap((result) => result.events);

  return [
    ...findSourcesWithoutFiles(input.parseResults, input.sourceFilter),
    ...findUnmatchedProviderWarning(events, input.providerFilter),
    ...findUnmatchedModelWarnings(events, input.modelFilter),
  ];
}
