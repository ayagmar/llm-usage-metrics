import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import {
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
  type PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { applyPricingToEvents } from '../pricing/cost-engine.js';
import { LiteLLMPricingFetcher } from '../pricing/litellm-pricing-fetcher.js';
import { createDefaultOpenAiPricingSource } from '../pricing/static-pricing-source.js';
import type { PricingSource } from '../pricing/types.js';
import { renderMarkdownTable } from '../render/markdown-table.js';
import { renderTerminalTable } from '../render/terminal-table.js';
import { CodexSourceAdapter } from '../sources/codex/codex-source-adapter.js';
import { PiSourceAdapter } from '../sources/pi/pi-source-adapter.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';

export type ReportCommandOptions = {
  piDir?: string;
  codexDir?: string;
  source?: string | string[];
  since?: string;
  until?: string;
  timezone?: string;
  provider?: string;
  markdown?: boolean;
  json?: boolean;
  pricingUrl?: string;
  pricingOffline?: boolean;
};

function validateDateInput(value: string, flagName: '--since' | '--until'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${flagName} must use format YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${flagName} has an invalid calendar date`);
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

function normalizeProviderFilter(provider: string | undefined): string | undefined {
  if (!provider) {
    return undefined;
  }

  const normalized = provider.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeSourceFilter(source: string | string[] | undefined): Set<string> | undefined {
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

function validateSourceFilterValues(
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

  const allowedSources = [...availableSourceIds].sort((left, right) => left.localeCompare(right));

  throw new Error(
    `Unknown --source value(s): ${unknownSources.join(', ')}. Allowed values: ${allowedSources.join(', ')}`,
  );
}

function matchesProvider(
  provider: string | undefined,
  providerFilter: string | undefined,
): boolean {
  if (!providerFilter) {
    return true;
  }

  return provider?.toLowerCase().includes(providerFilter) ?? false;
}

async function parseAdapterEvents(
  adapter: SourceAdapter,
  maxParallelFileParsing: number,
): Promise<UsageEvent[]> {
  const files = await adapter.discoverFiles();

  if (files.length === 0) {
    return [];
  }

  const parsedByFile: UsageEvent[][] = Array.from({ length: files.length }, () => []);
  const workerCount = Math.min(maxParallelFileParsing, files.length);
  let nextFileIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextFileIndex < files.length) {
      const fileIndex = nextFileIndex;
      nextFileIndex += 1;

      const filePath = files[fileIndex];

      if (!filePath) {
        break;
      }

      parsedByFile[fileIndex] = await adapter.parseFile(filePath);
    }
  });

  await Promise.all(workers);

  return parsedByFile.flat();
}

function filterEventsByDateRange(
  events: UsageEvent[],
  timezone: string,
  since: string | undefined,
  until: string | undefined,
): UsageEvent[] {
  return events.filter((event) => {
    const eventDate = getPeriodKey(event.timestamp, 'daily', timezone);

    if (since && eventDate < since) {
      return false;
    }

    if (until && eventDate > until) {
      return false;
    }

    return true;
  });
}

function validatePricingUrl(pricingUrl: string | undefined): void {
  if (!pricingUrl) {
    return;
  }

  try {
    const parsedUrl = new URL(pricingUrl);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Unsupported protocol');
    }
  } catch {
    throw new Error('--pricing-url must be a valid http(s) URL');
  }
}

async function resolvePricingSource(
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig,
): Promise<PricingSource> {
  const fallbackPricingSource = createDefaultOpenAiPricingSource();
  const litellmPricingFetcher = new LiteLLMPricingFetcher({
    sourceUrl: options.pricingUrl,
    offline: options.pricingOffline,
    cacheTtlMs: runtimeConfig.cacheTtlMs,
    fetchTimeoutMs: runtimeConfig.fetchTimeoutMs,
  });

  try {
    await litellmPricingFetcher.load();
    return litellmPricingFetcher;
  } catch (error) {
    if (options.pricingOffline) {
      throw new Error('Offline pricing mode enabled but cached pricing is unavailable');
    }

    if (options.pricingUrl) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load pricing from --pricing-url: ${reason}`);
    }

    return fallbackPricingSource;
  }
}

function eventNeedsPricingLookup(event: UsageEvent): boolean {
  if (!event.model) {
    return false;
  }

  return event.costMode !== 'explicit' || event.costUsd === undefined;
}

function shouldLoadPricingSource(options: ReportCommandOptions, events: UsageEvent[]): boolean {
  if (options.pricingUrl || options.pricingOffline) {
    return true;
  }

  return events.some((event) => eventNeedsPricingLookup(event));
}

export async function buildUsageReport(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
): Promise<string> {
  if (options.markdown && options.json) {
    throw new Error('Choose either --markdown or --json, not both');
  }

  if (options.since) {
    validateDateInput(options.since, '--since');
  }

  if (options.until) {
    validateDateInput(options.until, '--until');
  }

  if (options.since && options.until && options.since > options.until) {
    throw new Error('--since must be less than or equal to --until');
  }

  validatePricingUrl(options.pricingUrl);

  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimezone(timezone);

  const providerFilter = normalizeProviderFilter(options.provider);
  const sourceFilter = normalizeSourceFilter(options.source);
  const effectiveProviderFilter = providerFilter ?? 'openai';

  const parsingRuntimeConfig = getParsingRuntimeConfig();
  const pricingRuntimeConfig = getPricingFetcherRuntimeConfig();

  const adapters: SourceAdapter[] = [
    new PiSourceAdapter({
      sessionsDir: options.piDir,
      providerFilter: (provider) => matchesProvider(provider, effectiveProviderFilter),
    }),
    new CodexSourceAdapter({
      sessionsDir: options.codexDir,
    }),
  ];

  const availableSourceIds = new Set(adapters.map((adapter) => adapter.id.toLowerCase()));
  validateSourceFilterValues(sourceFilter, availableSourceIds);

  const adaptersToParse = sourceFilter
    ? adapters.filter((adapter) => sourceFilter.has(adapter.id.toLowerCase()))
    : adapters;

  const parsedEventsByAdapter = await Promise.all(
    adaptersToParse.map((adapter) =>
      parseAdapterEvents(adapter, parsingRuntimeConfig.maxParallelFileParsing),
    ),
  );
  const providerFilteredEvents = parsedEventsByAdapter
    .flat()
    .filter((event) => matchesProvider(event.provider, effectiveProviderFilter));

  const dateFilteredEvents = filterEventsByDateRange(
    providerFilteredEvents,
    timezone,
    options.since,
    options.until,
  );

  const pricedEvents = shouldLoadPricingSource(options, dateFilteredEvents)
    ? applyPricingToEvents(
        dateFilteredEvents,
        await resolvePricingSource(options, pricingRuntimeConfig),
      )
    : dateFilteredEvents;

  const rows = aggregateUsage(pricedEvents, {
    granularity,
    timezone,
  });

  if (options.json) {
    return JSON.stringify(rows, null, 2);
  }

  if (options.markdown) {
    return renderMarkdownTable(rows);
  }

  return renderTerminalTable(rows);
}

export async function runUsageReport(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
): Promise<void> {
  const output = await buildUsageReport(granularity, options);
  console.log(output);
}
