import { describe, expect, it } from 'vitest';

import {
  matchesCanonicalProviderFilter,
  normalizeProviderToBillingEntity,
} from '../../src/domain/provider-normalization.js';

describe('provider-normalization', () => {
  it('normalizes provider filters before canonical matching', () => {
    expect(matchesCanonicalProviderFilter('openai', ' OpenAI-Codex ')).toBe(true);
    expect(matchesCanonicalProviderFilter('openai-codex', ' openai ')).toBe(true);
    expect(matchesCanonicalProviderFilter('google', ' OpenAI-Codex ')).toBe(false);
  });

  it('treats blank provider filters as inactive and missing providers as non-matches', () => {
    expect(matchesCanonicalProviderFilter(undefined, '   ')).toBe(true);
    expect(matchesCanonicalProviderFilter(undefined, 'openai')).toBe(false);
  });

  it('normalizes known billing aliases', () => {
    expect(normalizeProviderToBillingEntity(' OpenAI/Codex ')).toBe('openai');
    expect(normalizeProviderToBillingEntity(' github-copilot ')).toBe('github');
  });
});
