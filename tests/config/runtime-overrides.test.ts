import { describe, expect, it } from 'vitest';

import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
  getUpdateNotifierRuntimeConfig,
} from '../../src/config/runtime-overrides.js';
import { getDefaultEventStorePath } from '../../src/persistence/event-store.js';

describe('runtime overrides', () => {
  it('uses defaults when env vars are missing', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig(env)).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
    });
    expect(getEventStoreRuntimeConfig(env)).toEqual({
      enabled: true,
      path: getDefaultEventStorePath(),
    });
  });

  it('reads valid numeric overrides from env', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_UPDATE_CACHE_TTL_MS: '7200000',
      LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS: '2500',
      LLM_USAGE_PRICING_CACHE_TTL_MS: '1800000',
      LLM_USAGE_PRICING_FETCH_TIMEOUT_MS: '5000',
      LLM_USAGE_PARSE_MAX_PARALLEL: '16',
      LLM_USAGE_EVENT_STORE: 'true',
      LLM_USAGE_EVENT_STORE_PATH: '/tmp/custom-events.db',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 7_200_000,
      fetchTimeoutMs: 2500,
    });
    expect(getPricingFetcherRuntimeConfig(env)).toEqual({
      cacheTtlMs: 1_800_000,
      fetchTimeoutMs: 5000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 16,
    });
    expect(getEventStoreRuntimeConfig(env)).toEqual({
      enabled: true,
      path: '/tmp/custom-events.db',
    });
  });

  it('clamps out-of-range env values to safe bounds', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_UPDATE_CACHE_TTL_MS: '-1',
      LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS: '999999',
      LLM_USAGE_PRICING_CACHE_TTL_MS: '-1',
      LLM_USAGE_PRICING_FETCH_TIMEOUT_MS: '1',
      LLM_USAGE_PARSE_MAX_PARALLEL: '0',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 0,
      fetchTimeoutMs: 30_000,
    });
    expect(getPricingFetcherRuntimeConfig(env)).toEqual({
      cacheTtlMs: 60_000,
      fetchTimeoutMs: 200,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 1,
    });
  });

  it('falls back for invalid non-numeric env values', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_UPDATE_CACHE_TTL_MS: 'abc',
      LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS: '',
      LLM_USAGE_PRICING_CACHE_TTL_MS: 'NaN',
      LLM_USAGE_PRICING_FETCH_TIMEOUT_MS: 'Infinity',
      LLM_USAGE_PARSE_MAX_PARALLEL: 'text',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig(env)).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
    });
  });

  it('rejects non-integer formats and uses defaults', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_UPDATE_CACHE_TTL_MS: '1e6',
      LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS: '1000.5',
      LLM_USAGE_PRICING_CACHE_TTL_MS: '0x100',
      LLM_USAGE_PRICING_FETCH_TIMEOUT_MS: '2_000',
      LLM_USAGE_PARSE_MAX_PARALLEL: '4.2',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
    });
    expect(getPricingFetcherRuntimeConfig(env)).toEqual({
      cacheTtlMs: 24 * 60 * 60 * 1000,
      fetchTimeoutMs: 4000,
    });
    expect(getParsingRuntimeConfig(env)).toEqual({
      maxParallelFileParsing: 8,
    });
  });

  it('accepts zero update cache ttl for per-run checks', () => {
    const env: NodeJS.ProcessEnv = {
      LLM_USAGE_UPDATE_CACHE_TTL_MS: '0',
    };

    expect(getUpdateNotifierRuntimeConfig(env)).toEqual({
      cacheTtlMs: 0,
      fetchTimeoutMs: 1000,
    });
  });
});
