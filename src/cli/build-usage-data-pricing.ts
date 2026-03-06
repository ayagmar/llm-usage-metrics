import { isPriceableEvent, type UsageEvent } from '../domain/usage-event.js';
import {
  getPricingFetcherRuntimeConfig,
  type PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import { applyPricingToEvents } from '../pricing/cost-engine.js';
import type { PricingSource } from '../pricing/types.js';
import { LiteLLMPricingFetcher } from '../pricing/litellm-pricing-fetcher.js';

import type {
  PricingLoadResult,
  ReportCommandOptions,
  UsagePricingOrigin,
} from './usage-data-contracts.js';

export async function resolvePricingSource(
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig,
): Promise<PricingLoadResult> {
  const litellmPricingFetcher = new LiteLLMPricingFetcher({
    sourceUrl: options.pricingUrl,
    offline: options.pricingOffline,
    cacheTtlMs: runtimeConfig.cacheTtlMs,
    fetchTimeoutMs: runtimeConfig.fetchTimeoutMs,
  });

  try {
    const fromCache = await litellmPricingFetcher.load();

    if (options.pricingOffline) {
      return { source: litellmPricingFetcher, origin: 'offline-cache' };
    }

    return { source: litellmPricingFetcher, origin: fromCache ? 'cache' : 'network' };
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

export function eventNeedsPricingLookup(event: UsageEvent): boolean {
  if (!event.model) {
    return false;
  }

  if (!isPriceableEvent(event)) {
    return false;
  }

  return event.costMode !== 'explicit' || event.costUsd === undefined || event.costUsd === 0;
}

export function shouldLoadPricingSource(events: UsageEvent[]): boolean {
  if (events.length === 0) {
    return false;
  }

  return events.some((event) => eventNeedsPricingLookup(event));
}

export type PricingLoadMode = 'auto' | 'force';

function shouldLoadPricingSourceForMode(
  events: UsageEvent[],
  pricingLoadMode: PricingLoadMode,
): boolean {
  if (pricingLoadMode === 'force') {
    return events.some((event) => isPriceableEvent(event));
  }

  return shouldLoadPricingSource(events);
}

type PricingSourceResolver = (
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig,
) => Promise<PricingLoadResult>;

export async function resolveAndApplyPricingToEvents(
  events: UsageEvent[],
  options: ReportCommandOptions,
  runtimeConfig: PricingFetcherRuntimeConfig = getPricingFetcherRuntimeConfig(),
  loadPricingSource: PricingSourceResolver = resolvePricingSource,
  pricingLoadMode: PricingLoadMode = 'auto',
): Promise<{
  pricedEvents: UsageEvent[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  pricingSource?: PricingSource;
}> {
  let pricingOrigin: UsagePricingOrigin = 'none';

  if (!shouldLoadPricingSourceForMode(events, pricingLoadMode)) {
    return {
      pricedEvents: events,
      pricingOrigin,
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
      pricedEvents: events,
      pricingOrigin,
      pricingWarning,
    };
  }

  pricingOrigin = pricingResult.origin;

  return {
    pricedEvents: applyPricingToEvents(events, pricingResult.source),
    pricingOrigin,
    pricingSource: pricingResult.source,
  };
}
