import { describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '@ayagmar/agent-sessions/registry';

import { selectAdaptersForParsing } from '../../../src/cli/build-usage-data-inputs.js';

describe('createDefaultAdapters', () => {
  it('keeps antigravity for a Claude model scope, since it serves Claude models too', () => {
    const selected = selectAdaptersForParsing(createDefaultAdapters({}), {
      sourceFilter: undefined,
      candidateProviderRoots: ['anthropic'],
    }).map((adapter) => adapter.id);

    expect(selected).toContain('antigravity');
    expect(selected).not.toContain('gemini');
  });
});
