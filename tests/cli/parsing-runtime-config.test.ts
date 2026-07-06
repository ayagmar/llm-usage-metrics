import { describe, expect, it } from 'vitest';

import { getEventStoreRuntimeConfig } from '../../src/config/runtime-overrides.js';

describe('parsing runtime config', () => {
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
