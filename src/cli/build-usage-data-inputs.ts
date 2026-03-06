import type { SourceAdapter } from '../sources/source-adapter.js';
import {
  inferCanonicalProviderRootsFromModels,
  intersectCanonicalProviderRoots,
  normalizeProviderToBillingEntity,
  resolveExplicitProviderRoots,
} from '../domain/provider-normalization.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { parseSourceDirectoryOverrides } from '../utils/source-directory-overrides.js';
import type { RuntimeProfileCollector } from './runtime-profile.js';

import type { ReportCommandOptions } from './usage-data-contracts.js';

export type NormalizedBuildUsageInputs = {
  timezone: string;
  providerFilter: string | undefined;
  candidateProviderRoots: string[] | undefined;
  sourceFilter: Set<string> | undefined;
  modelFilter: string[] | undefined;
  explicitSourceIds: Set<string>;
  pricingUrl: string | undefined;
};

export function validateDateInput(value: string, flagName: '--since' | '--until'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${flagName} must use format YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${flagName} has an invalid calendar date`);
  }
}

export function validateTimezone(timezone: string): void {
  const normalizedTimezone = timezone.trim();

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalizedTimezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${normalizedTimezone}`);
  }
}

export function normalizeProviderFilter(provider: string | undefined): string | undefined {
  return normalizeProviderToBillingEntity(provider);
}

export function normalizeSourceFilter(
  source: string | string[] | undefined,
): Set<string> | undefined {
  if (!source || (Array.isArray(source) && source.length === 0)) {
    return undefined;
  }

  const sourceCandidates = Array.isArray(source) ? source : [source];
  const normalizedSources = sourceCandidates
    .flatMap((candidate) => candidate.split(','))
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0);

  if (normalizedSources.length === 0) {
    throw new Error('--source must contain at least one non-empty source id');
  }

  return new Set(normalizedSources);
}

export function normalizeModelFilter(model: string | string[] | undefined): string[] | undefined {
  if (!model || (Array.isArray(model) && model.length === 0)) {
    return undefined;
  }

  const modelCandidates = Array.isArray(model) ? model : [model];
  const normalizedModels = modelCandidates
    .flatMap((candidate) => candidate.split(','))
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0);

  if (normalizedModels.length === 0) {
    throw new Error('--model must contain at least one non-empty model filter');
  }

  return [...new Set(normalizedModels)];
}

export function validateSourceFilterValues(
  sourceFilter: Set<string> | undefined,
  availableSourceIds: ReadonlySet<string>,
): void {
  if (!sourceFilter) {
    return;
  }

  const unknownSources = [...sourceFilter].filter((source) => !availableSourceIds.has(source));

  if (unknownSources.length === 0) {
    return;
  }

  const allowedSources = [...availableSourceIds].sort(compareByCodePoint);

  throw new Error(
    `Unknown --source value(s): ${unknownSources.join(', ')}. Allowed values: ${allowedSources.join(', ')}`,
  );
}

export function validatePricingUrl(pricingUrl: string | undefined): string | undefined {
  if (pricingUrl === undefined) {
    return undefined;
  }

  const normalizedPricingUrl = pricingUrl.trim();

  if (normalizedPricingUrl.length === 0) {
    throw new Error('--pricing-url must be a valid http(s) URL');
  }

  try {
    const parsedUrl = new URL(normalizedPricingUrl);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Unsupported protocol');
    }
  } catch {
    throw new Error('--pricing-url must be a valid http(s) URL');
  }

  return normalizedPricingUrl;
}

export function validateBuildOptions(options: ReportCommandOptions): {
  normalizedPricingUrl: string | undefined;
} {
  if (options.since) {
    validateDateInput(options.since, '--since');
  }

  if (options.until) {
    validateDateInput(options.until, '--until');
  }

  if (options.since && options.until && options.since > options.until) {
    throw new Error('--since must be less than or equal to --until');
  }

  return {
    normalizedPricingUrl: validatePricingUrl(options.pricingUrl),
  };
}

export function resolveExplicitSourceIds(
  options: ReportCommandOptions,
  sourceFilter: Set<string> | undefined,
): Set<string> {
  const explicitSourceIds = new Set<string>();

  if (sourceFilter) {
    for (const sourceId of sourceFilter) {
      explicitSourceIds.add(sourceId);
    }
  }

  for (const sourceId of parseSourceDirectoryOverrides(options.sourceDir).keys()) {
    explicitSourceIds.add(sourceId);
  }

  if (options.piDir) {
    explicitSourceIds.add('pi');
  }

  if (options.codexDir) {
    explicitSourceIds.add('codex');
  }

  if (options.geminiDir) {
    explicitSourceIds.add('gemini');
  }

  if (options.droidDir) {
    explicitSourceIds.add('droid');
  }

  if (options.opencodeDb) {
    explicitSourceIds.add('opencode');
  }

  return explicitSourceIds;
}

function detectDefaultTimezone(): string {
  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (typeof detectedTimezone === 'string') {
    const trimmedDetectedTimezone = detectedTimezone.trim();

    if (trimmedDetectedTimezone.length > 0) {
      return trimmedDetectedTimezone;
    }
  }

  return 'UTC';
}

export function normalizeBuildUsageInputs(
  options: ReportCommandOptions,
): NormalizedBuildUsageInputs {
  const { normalizedPricingUrl } = validateBuildOptions(options);

  const timezone =
    options.timezone !== undefined ? options.timezone.trim() : detectDefaultTimezone();
  validateTimezone(timezone);

  const providerFilter = normalizeProviderFilter(options.provider);
  const sourceFilter = normalizeSourceFilter(options.source);
  const modelFilter = normalizeModelFilter(options.model);
  const candidateProviderRoots = intersectCanonicalProviderRoots(
    resolveExplicitProviderRoots(providerFilter),
    inferCanonicalProviderRootsFromModels(modelFilter),
  );
  const explicitSourceIds = resolveExplicitSourceIds(options, sourceFilter);

  return {
    timezone,
    providerFilter,
    candidateProviderRoots,
    sourceFilter,
    modelFilter,
    explicitSourceIds,
    pricingUrl: normalizedPricingUrl,
  };
}

export function selectAdaptersForParsing(
  adapters: SourceAdapter[],
  options: {
    sourceFilter: Set<string> | undefined;
    candidateProviderRoots: string[] | undefined;
    runtimeProfile?: RuntimeProfileCollector;
  },
): SourceAdapter[] {
  const availableSourceIds = new Set(adapters.map((adapter) => adapter.id.toLowerCase()));
  validateSourceFilterValues(options.sourceFilter, availableSourceIds);

  const sourceFilter = options.sourceFilter;
  const selectedBySource = sourceFilter
    ? adapters.filter((adapter) => sourceFilter.has(adapter.id.toLowerCase()))
    : adapters;

  if (!options.candidateProviderRoots) {
    options.runtimeProfile?.recordSourceSelection({
      availableSourceIds: adapters.map((adapter) => adapter.id),
      selectedSourceIds: selectedBySource.map((adapter) => adapter.id),
    });
    return selectedBySource;
  }

  const candidateProviderRootSet = new Set(options.candidateProviderRoots);

  const selectedAdapters = selectedBySource.filter((adapter) => {
    const fixedProviderRoots = adapter.capabilities?.fixedProviderRoots;

    if (!fixedProviderRoots || fixedProviderRoots.length === 0) {
      return true;
    }

    return fixedProviderRoots.some((providerRoot) => candidateProviderRootSet.has(providerRoot));
  });

  options.runtimeProfile?.recordSourceSelection({
    availableSourceIds: adapters.map((adapter) => adapter.id),
    selectedSourceIds: selectedAdapters.map((adapter) => adapter.id),
    candidateProviderRoots: options.candidateProviderRoots,
  });

  return selectedAdapters;
}
