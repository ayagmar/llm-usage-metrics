import { describe, expect, it } from 'vitest';

import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
} from '../../src/config/runtime-overrides.js';

describe('parsing runtime config', () => {
  it('accepts parse cache boolean aliases', () => {
    expect(
      getParsingRuntimeConfig({
        LLM_USAGE_PARSE_CACHE_ENABLED: '0',
      }),
    ).toMatchObject({ parseCacheEnabled: false });

    expect(
      getParsingRuntimeConfig({
        LLM_USAGE_PARSE_CACHE_ENABLED: 'yes',
      }),
    ).toMatchObject({ parseCacheEnabled: true });
  });

  it('falls back to default for blank parse cache enabled values', () => {
    expect(
      getParsingRuntimeConfig({
        LLM_USAGE_PARSE_CACHE_ENABLED: '   ',
      }),
    ).toMatchObject({ parseCacheEnabled: true });
  });

  it('accepts event store boolean aliases', () => {
    expect(
      getEventStoreRuntimeConfig({
        LLM_USAGE_EVENT_STORE: '0',
      }),
    ).toMatchObject({ enabled: false });

    expect(
      getEventStoreRuntimeConfig({
        LLM_USAGE_EVENT_STORE: 'yes',
      }),
    ).toMatchObject({ enabled: true });
  });
});
