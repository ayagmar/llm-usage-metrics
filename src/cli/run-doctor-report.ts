import { stat } from 'node:fs/promises';

import {
  getEventStoreRuntimeConfig,
  type EventStoreRuntimeConfig,
} from '../config/runtime-overrides.js';
import {
  closeEventStore as closeDefaultEventStore,
  countEvents as countDefaultEventStoreEvents,
  openEventStore as openDefaultEventStore,
  type EventStore,
} from '../persistence/event-store.js';
import { createDefaultAdapters, getDefaultSourceIds } from '../sources/create-default-adapters.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { normalizeSourceFilter, validateSourceFilterValues } from './build-usage-data-inputs.js';
import type { DoctorCommandOptions } from './usage-data-contracts.js';

export type DoctorSourceResult = {
  id: string;
  status: 'ok' | 'error';
  itemsFound?: number;
  detail?: string;
  error?: string;
};

type DoctorDeps = {
  getEventStoreRuntimeConfig?: () => EventStoreRuntimeConfig;
  openEventStore?: (filePath: string) => Promise<EventStore>;
  closeEventStore?: (store: EventStore) => void;
  countEvents?: (store: EventStore) => number;
};

function getErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function selectDoctorAdapters(
  adapters: SourceAdapter[],
  source: DoctorCommandOptions['source'],
): SourceAdapter[] {
  const sourceFilter = normalizeSourceFilter(source);
  validateSourceFilterValues(sourceFilter, new Set(getDefaultSourceIds()));

  if (!sourceFilter) {
    return adapters;
  }

  return adapters.filter((adapter) => sourceFilter.has(adapter.id.toLowerCase()));
}

export async function buildDoctorResults(
  options: DoctorCommandOptions,
  deps: DoctorDeps = {},
): Promise<DoctorSourceResult[]> {
  const adapters = selectDoctorAdapters(createDefaultAdapters(options), options.source);
  const results: DoctorSourceResult[] = [];

  for (const adapter of adapters) {
    try {
      const files = await adapter.discoverFiles();
      results.push({
        id: adapter.id,
        status: 'ok',
        itemsFound: files.length,
      });
    } catch (error) {
      results.push({
        id: adapter.id,
        status: 'error',
        error: getErrorReason(error),
      });
    }
  }

  const eventStoreRuntimeConfig = (deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig)();

  if (eventStoreRuntimeConfig.enabled) {
    results.push(await buildEventStoreDoctorResult(eventStoreRuntimeConfig.path, deps));
  }

  return results;
}

async function buildEventStoreDoctorResult(
  filePath: string,
  deps: DoctorDeps,
): Promise<DoctorSourceResult> {
  try {
    await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        id: 'event-store',
        status: 'ok',
        itemsFound: 0,
        detail: 'not yet created',
      };
    }

    return {
      id: 'event-store',
      status: 'error',
      error: getErrorReason(error),
    };
  }

  const openEventStore = deps.openEventStore ?? openDefaultEventStore;
  const closeEventStore = deps.closeEventStore ?? closeDefaultEventStore;
  const countEvents = deps.countEvents ?? countDefaultEventStoreEvents;
  let store: EventStore | undefined;

  try {
    store = await openEventStore(filePath);
    const eventCount = countEvents(store);

    return {
      id: 'event-store',
      status: 'ok',
      itemsFound: eventCount,
      detail: `${eventCount} event(s)`,
    };
  } catch (error) {
    return {
      id: 'event-store',
      status: 'error',
      error: getErrorReason(error),
    };
  } finally {
    if (store) {
      closeEventStore(store);
    }
  }
}

function renderDoctorText(results: DoctorSourceResult[]): string {
  const idWidth = Math.max(...results.map((result) => result.id.length), 0);
  const statusWidth = 5;
  const lines = results.map((result) => {
    const detail =
      result.status === 'ok'
        ? (result.detail ?? `${result.itemsFound ?? 0} file(s)`)
        : (result.error ?? 'Unknown');

    return `${result.id.padEnd(idWidth)}  ${result.status.padEnd(statusWidth)}  ${detail}`;
  });
  const healthyCount = results.filter((result) => result.status === 'ok').length;

  return [...lines, '', `${healthyCount}/${results.length} sources healthy`].join('\n');
}

export async function runDoctorReport(
  options: DoctorCommandOptions,
  deps: DoctorDeps = {},
): Promise<void> {
  const results = await buildDoctorResults(options, deps);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ sources: results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderDoctorText(results)}\n`);
}
