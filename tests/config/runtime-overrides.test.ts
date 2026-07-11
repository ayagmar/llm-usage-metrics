import { availableParallelism } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
  getUpdateNotifierRuntimeConfig,
} from '../../src/config/runtime-overrides.js';
import { getDefaultEventStorePath } from '../../src/persistence/event-store.js';

function getExpectedAutoParseWorkerCount(): number {
  return Math.max(0, Math.min(8, availableParallelism() - 1));
}

describe('runtime overrides', () => {
  it('uses defaults when env vars are missing', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      skipCheck: false,
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig()).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
      parseWorkers: getExpectedAutoParseWorkerCount(),
      parseWorkerMinBytes: 268_435_456,
    });
    expect(getEventStoreRuntimeConfig(env)).toEqual({
      enabled: true,
      path: getDefaultEventStorePath(),
    });
  });

  it('reads valid numeric overrides from env', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_PARSE_WORKERS: '6',
      LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1024',
      LLM_USAGE_EVENT_STORE: 'true',
      LLM_USAGE_EVENT_STORE_PATH: '/tmp/custom-events.db',
      LLM_USAGE_SKIP_UPDATE_CHECK: 'yes',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      skipCheck: true,
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig()).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
      parseWorkers: 6,
      parseWorkerMinBytes: 1024,
    });
    expect(getEventStoreRuntimeConfig(env)).toEqual({
      enabled: true,
      path: '/tmp/custom-events.db',
    });
  });

  it('clamps out-of-range env values to safe bounds', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_PARSE_WORKERS: '-1',
      LLM_USAGE_PARSE_WORKER_MIN_BYTES: '-1',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      skipCheck: false,
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig()).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
      parseWorkers: 0,
      parseWorkerMinBytes: 0,
    });
  });

  it('falls back for invalid non-numeric env values', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_PARSE_WORKERS: 'text',
      LLM_USAGE_PARSE_WORKER_MIN_BYTES: 'text',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      skipCheck: false,
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig()).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
      parseWorkers: getExpectedAutoParseWorkerCount(),
      parseWorkerMinBytes: 268_435_456,
    });
  });

  it('rejects non-integer formats and uses defaults', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_PARSE_WORKERS: '4.2',
      LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1e6',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      skipCheck: false,
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig()).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
      parseWorkers: getExpectedAutoParseWorkerCount(),
      parseWorkerMinBytes: 268_435_456,
    });
  });

  it('keeps the event store disabled for the test process (vitest env isolation)', () => {
    expect(getEventStoreRuntimeConfig().enabled).toBe(false);
  });

  it('accepts zero update cache ttl from config for per-run checks', () => {
    expect(getUpdateNotifierRuntimeConfig({}, { update: { cacheTtlMs: 0 } })).toEqual({
      skipCheck: false,
      cacheTtlMs: 0,
      fetchTimeoutMs: 1000,
    });
  });

  it('uses config values below env vars and above defaults', () => {
    expect(
      getUpdateNotifierRuntimeConfig(
        {
          LLM_USAGE_SKIP_UPDATE_CHECK: '0',
        },
        {
          update: {
            skipCheck: true,
            cacheTtlMs: 2_000,
            fetchTimeoutMs: 500,
          },
        },
      ),
    ).toEqual({
      skipCheck: false,
      cacheTtlMs: 2_000,
      fetchTimeoutMs: 500,
    });

    expect(
      getPricingFetcherRuntimeConfig({
        pricing: {
          cacheTtlMs: 60_000,
          fetchTimeoutMs: 5_000,
        },
      }),
    ).toEqual({
      cacheTtlMs: 60_000,
      fetchTimeoutMs: 5_000,
    });

    expect(
      getParsingRuntimeConfig(
        {
          LLM_USAGE_PARSE_WORKERS: '2',
          LLM_USAGE_PARSE_WORKER_MIN_BYTES: '4096',
        },
        {
          parseMaxParallel: 12,
          parseWorkers: 6,
          parseWorkerMinBytes: 1024,
        },
      ),
    ).toEqual({
      maxParallelFileParsing: 12,
      parseWorkers: 2,
      parseWorkerMinBytes: 4096,
    });

    expect(
      getEventStoreRuntimeConfig(
        {
          LLM_USAGE_EVENT_STORE: '1',
          LLM_USAGE_EVENT_STORE_PATH: '/tmp/env-events.db',
        },
        {
          eventStore: {
            enabled: false,
            path: '/tmp/config-events.db',
          },
        },
      ),
    ).toEqual({
      enabled: true,
      path: '/tmp/env-events.db',
    });
  });

  it('reports provenance when the event store is disabled', () => {
    expect(getEventStoreRuntimeConfig({ LLM_USAGE_EVENT_STORE: '0' })).toEqual({
      enabled: false,
      path: getDefaultEventStorePath(),
      disabledBy: 'environment',
    });

    expect(
      getEventStoreRuntimeConfig({}, { eventStore: { enabled: false, path: '/tmp/events.db' } }),
    ).toEqual({
      enabled: false,
      path: '/tmp/events.db',
      disabledBy: 'configuration',
    });

    expect(
      getEventStoreRuntimeConfig(
        { LLM_USAGE_EVENT_STORE: '0' },
        { eventStore: { enabled: false, path: '/tmp/events.db' } },
      ),
    ).toEqual({
      enabled: false,
      path: '/tmp/events.db',
      disabledBy: 'environment',
    });

    expect(
      getEventStoreRuntimeConfig(
        { LLM_USAGE_EVENT_STORE: 'garbage' },
        { eventStore: { enabled: false, path: '/tmp/events.db' } },
      ),
    ).toEqual({
      enabled: false,
      path: '/tmp/events.db',
      disabledBy: 'configuration',
    });

    expect(
      getEventStoreRuntimeConfig(
        { LLM_USAGE_EVENT_STORE: '1' },
        { eventStore: { enabled: false, path: '/tmp/events.db' } },
      ),
    ).toEqual({
      enabled: true,
      path: '/tmp/events.db',
    });

    expect(getEventStoreRuntimeConfig({})).toEqual({
      enabled: true,
      path: getDefaultEventStorePath(),
    });
  });

  it('resolves auto parse workers from config or env', () => {
    expect(getParsingRuntimeConfig({}, { parseWorkers: 'auto' }).parseWorkers).toBe(
      getExpectedAutoParseWorkerCount(),
    );
    expect(
      getParsingRuntimeConfig({ LLM_USAGE_PARSE_WORKERS: 'auto' }, { parseWorkers: 2 })
        .parseWorkers,
    ).toBe(getExpectedAutoParseWorkerCount());
  });
});
