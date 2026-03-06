import { describe, expect, it } from 'vitest';

import {
  collectCanonicalProviderRoots,
  inferCanonicalProviderRootsFromModels,
  matchesCanonicalProviderFilter,
  normalizeProviderToBillingEntity,
  resolveExplicitProviderRoots,
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

  it('resolves explicit provider roots only for canonical roots', () => {
    expect(resolveExplicitProviderRoots(undefined)).toBeUndefined();
    expect(resolveExplicitProviderRoots(' openai ')).toEqual(['openai']);
    expect(resolveExplicitProviderRoots(' vendor-openai ')).toBeUndefined();
  });

  it('infers canonical provider roots from explicit models conservatively', () => {
    expect(inferCanonicalProviderRootsFromModels([' gpt-5.2 ', 'o3-mini'])).toEqual(['openai']);
    expect(inferCanonicalProviderRootsFromModels(['   '])).toBeUndefined();
    expect(inferCanonicalProviderRootsFromModels(['custom-model'])).toBeUndefined();
  });

  it('collects canonical provider roots in deterministic order', () => {
    expect(
      collectCanonicalProviderRoots(['OpenAI-Codex', ' google ', undefined, 'openai']),
    ).toEqual(['google', 'openai']);
  });
});
