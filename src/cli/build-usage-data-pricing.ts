import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { isPriceableEvent, type UsageEvent } from '../domain/usage-event.js';
import {
  getPricingFetcherRuntimeConfig,
  type PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import {
  applyPricingToEvents,
  createPricingRunStats,
  DEFAULT_PRICING_POLICY,
  type PricingCostMode,
  type PricingPolicy,
  type PricingRunStats,
} from '../pricing/cost-engine.js';
import { PricingOverrideSource, loadPricingOverrides } from '../pricing/pricing-override-source.js';
import type { ModelPricing, PricingSource } from '../pricing/types.js';
import { LiteLLMPricingFetcher } from '../pricing/litellm-pricing-fetcher.js';

import type {
  PricingLoadResult,
  ReportCommandOptions,
  UsagePricingOrigin,
} from './usage-data-contracts.js';

/** Sources whose usage events each record one request, so per-request rates apply. */
export function getPerRequestSourceIds(adapters: readonly SourceAdapter[]): ReadonlySet<string> {
  return new Set(
    adapters
      .filter((adapter) => adapter.capabilities?.usagePerRequest)
      .map((adapter) => adapter.id),
  );
}

function wrapWithPricingOverrides(
  overrides: Map<string, ModelPricing> | undefined,
  delegate: PricingSource,
): PricingSource {
  if (!overrides || overrides.size === 0) {
    return delegate;
  }

  return new PricingOverrideSource(overrides, delegate);
}

export async function resolvePricingSource(
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig,
): Promise<PricingLoadResult> {
  // Load the overrides file before touching LiteLLM so a bad --pricing-overrides
  // path fails fast with an accurate message and is never misreported as a
  // LiteLLM/cache/URL failure.
  let pricingOverrides: Map<string, ModelPricing> | undefined;

  if (options.pricingOverrides) {
    try {
      pricingOverrides = await loadPricingOverrides(options.pricingOverrides);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not load --pricing-overrides from ${options.pricingOverrides}: ${reason}`,
        {
          cause: error,
        },
      );
    }
  }

  const litellmPricingFetcher = new LiteLLMPricingFetcher({
    sourceUrl: options.pricingUrl,
    offline: options.pricingOffline,
    cacheTtlMs: runtimeConfig.cacheTtlMs,
    fetchTimeoutMs: runtimeConfig.fetchTimeoutMs,
  });

  try {
    const fromCache = await litellmPricingFetcher.load();
    const source = wrapWithPricingOverrides(pricingOverrides, litellmPricingFetcher);
    const loadOrigin = litellmPricingFetcher.getLoadOrigin();

    if (loadOrigin === 'bundled-snapshot') {
      return {
        source,
        origin: 'bundled-snapshot',
        warning: litellmPricingFetcher.getPricingWarning(),
      };
    }

    if (options.pricingOffline) {
      return { source, origin: 'offline-cache' };
    }

    return { source, origin: fromCache ? 'cache' : 'network' };
  } catch (error) {
    if (options.pricingOffline) {
      throw new Error('Offline pricing mode enabled but cached pricing is unavailable', {
        cause: error,
      });
    }

    const reason = error instanceof Error ? error.message : String(error);

    if (options.pricingUrl) {
      throw new Error(`Could not load pricing from --pricing-url: ${reason}`, {
        cause: error,
      });
    }

    throw new Error(`Could not load LiteLLM pricing: ${reason}`, { cause: error });
  }
}

function eventNeedsPricingLookup(event: UsageEvent, costMode: PricingCostMode): boolean {
  if (!event.model) {
    return false;
  }

  if (!isPriceableEvent(event)) {
    return false;
  }

  if (costMode === 'estimated') {
    return true;
  }

  return event.costMode !== 'explicit' || event.costUsd === undefined || event.costUsd === 0;
}

export function shouldLoadPricingSource(
  events: UsageEvent[],
  costMode: PricingCostMode = 'both',
): boolean {
  if (events.length === 0) {
    return false;
  }

  return events.some((event) => eventNeedsPricingLookup(event, costMode));
}

/**
 * When a report loads prices:
 * - `auto`: only to estimate event costs, so never under `--cost-mode explicit`.
 * - `cache-savings`: as `auto`, and under `--cost-mode explicit` still when `both` would
 *   load, for the cache-savings estimate.
 * - `force`: whenever an event is priceable, for prices beyond event costs (optimize).
 */
export type PricingLoadMode = 'auto' | 'cache-savings' | 'force';

function shouldLoadPricingSourceForMode(
  events: UsageEvent[],
  pricingLoadMode: PricingLoadMode,
  costMode: PricingCostMode,
): boolean {
  if (pricingLoadMode === 'force') {
    return events.some((event) => isPriceableEvent(event));
  }

  if (costMode === 'explicit') {
    return pricingLoadMode === 'cache-savings' && shouldLoadPricingSource(events, 'both');
  }

  return shouldLoadPricingSource(events, costMode);
}

/** Prices nothing: applying it gives each event its cost under the policy without LiteLLM. */
const NO_PRICING_SOURCE: PricingSource = {
  resolveModelAlias: (model) => model,
  getPricing: () => undefined,
};

/**
 * The policy for the report options: `--cost-mode`, `both` when it is not passed, and the
 * sources whose events get per-request rates.
 */
export function resolvePricingPolicy(
  options: ReportCommandOptions,
  perRequestSourceIds: ReadonlySet<string> = DEFAULT_PRICING_POLICY.perRequestSourceIds,
): PricingPolicy {
  return {
    costMode: options.costMode ?? DEFAULT_PRICING_POLICY.costMode,
    perRequestSourceIds,
  };
}

/**
 * Events left unpriced because pricing did not load. `both` keeps them as they are; the other
 * modes still drop the costs they do not report.
 */
function applyPolicyWithoutPricing(
  events: UsageEvent[],
  policy: PricingPolicy,
  stats: PricingRunStats,
): UsageEvent[] {
  return policy.costMode === 'both'
    ? events
    : applyPricingToEvents(events, NO_PRICING_SOURCE, { policy, stats });
}

type PricingSourceResolver = (
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig,
) => Promise<PricingLoadResult>;

export type ResolveAndApplyPricingOptions = {
  runtimeConfig?: PricingFetcherRuntimeConfig;
  loadPricingSource?: PricingSourceResolver;
  pricingLoadMode?: PricingLoadMode;
  policy?: PricingPolicy;
  /** The events that decide whether prices load; the priced events when not given. */
  loadDecisionEvents?: UsageEvent[];
};

export type PricedEventsResult = {
  pricedEvents: UsageEvent[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  pricingSource?: PricingSource;
  /** The policy the events were priced under. */
  pricingPolicy: PricingPolicy;
  /** What the run recorded about the priced events; empty when pricing did not run. */
  pricingStats: PricingRunStats;
  /** The `--cost-mode` passed, if any; the explicit-$0 note shows only without it. */
  costModeOption?: PricingCostMode;
};

export async function resolveAndApplyPricingToEvents(
  events: UsageEvent[],
  options: ReportCommandOptions,
  {
    runtimeConfig = getPricingFetcherRuntimeConfig(),
    loadPricingSource = resolvePricingSource,
    pricingLoadMode = 'auto',
    policy = resolvePricingPolicy(options),
    loadDecisionEvents = events,
  }: ResolveAndApplyPricingOptions = {},
): Promise<PricedEventsResult> {
  const pricingStats = createPricingRunStats();
  let pricingOrigin: UsagePricingOrigin = 'none';

  const costModeOption = options.costMode;

  if (!shouldLoadPricingSourceForMode(loadDecisionEvents, pricingLoadMode, policy.costMode)) {
    return {
      pricedEvents: applyPolicyWithoutPricing(events, policy, pricingStats),
      costModeOption,
      pricingOrigin,
      pricingPolicy: policy,
      pricingStats,
    };
  }

  let pricingResult: PricingLoadResult;

  try {
    pricingResult = await loadPricingSource(options, runtimeConfig);
  } catch (error) {
    if (!options.ignorePricingFailures) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    const pricingWarning = reason.trim().startsWith('Could not load')
      ? reason
      : `Could not load pricing; continuing without estimated costs: ${reason}`;

    return {
      pricedEvents: applyPolicyWithoutPricing(events, policy, pricingStats),
      costModeOption,
      pricingOrigin,
      pricingWarning,
      pricingPolicy: policy,
      pricingStats,
    };
  }

  pricingOrigin = pricingResult.origin;

  return {
    pricedEvents: applyPricingToEvents(events, pricingResult.source, {
      policy,
      stats: pricingStats,
    }),
    costModeOption,
    pricingOrigin,
    pricingWarning: pricingResult.warning,
    pricingSource: pricingResult.source,
    pricingPolicy: policy,
    pricingStats,
  };
}
