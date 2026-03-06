import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatEnvVarOverrides,
  getActiveEnvVarOverrides,
} from '../../src/config/env-var-display.js';

function clearTestEnvVars(): void {
  delete process.env.LLM_USAGE_SKIP_UPDATE_CHECK;
  delete process.env.LLM_USAGE_UPDATE_CACHE_SCOPE;
  delete process.env.LLM_USAGE_UPDATE_CACHE_SESSION_KEY;
  delete process.env.LLM_USAGE_UPDATE_CACHE_TTL_MS;
  delete process.env.LLM_USAGE_UPDATE_FETCH_TIMEOUT_MS;
  delete process.env.LLM_USAGE_PRICING_CACHE_TTL_MS;
  delete process.env.LLM_USAGE_PRICING_FETCH_TIMEOUT_MS;
  delete process.env.LLM_USAGE_PARSE_MAX_PARALLEL;
  delete process.env.LLM_USAGE_PARSE_CACHE_ENABLED;
  delete process.env.LLM_USAGE_PARSE_CACHE_TTL_MS;
  delete process.env.LLM_USAGE_PARSE_CACHE_MAX_ENTRIES;
  delete process.env.LLM_USAGE_PARSE_CACHE_MAX_BYTES;
  delete process.env.LLM_USAGE_PROFILE_RUNTIME;
  delete process.env.UNRELATED_ENV;
}

beforeEach(() => {
  clearTestEnvVars();
});

afterEach(() => {
  clearTestEnvVars();
});

describe('env-var-display', () => {
  it('returns only active known env var overrides', () => {
    process.env.LLM_USAGE_SKIP_UPDATE_CHECK = '1';
    process.env.LLM_USAGE_PARSE_MAX_PARALLEL = '16';
    process.env.LLM_USAGE_PROFILE_RUNTIME = '1';
    process.env.UNRELATED_ENV = 'ignored';

    const overrides = getActiveEnvVarOverrides();

    expect(overrides).toEqual([
      {
        name: 'LLM_USAGE_SKIP_UPDATE_CHECK',
        value: '1',
        description: 'skip startup update check',
      },
      {
        name: 'LLM_USAGE_PARSE_MAX_PARALLEL',
        value: '16',
        description: 'max parallel file parsing',
      },
      {
        name: 'LLM_USAGE_PROFILE_RUNTIME',
        value: '1',
        description: 'emit runtime profiling diagnostics',
      },
    ]);
  });

  it('formats overrides without a leading blank line', () => {
    const formatted = formatEnvVarOverrides([
      {
        name: 'LLM_USAGE_PRICING_FETCH_TIMEOUT_MS',
        value: '8000',
        description: 'pricing fetch timeout',
      },
    ]);

    expect(formatted).toEqual([
      'Active environment overrides:',
      '  LLM_USAGE_PRICING_FETCH_TIMEOUT_MS=8000  (pricing fetch timeout)',
    ]);
  });
});
