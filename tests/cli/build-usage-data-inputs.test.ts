import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeBuildUsageInputs,
  selectAdaptersForParsing,
} from '../../src/cli/build-usage-data-inputs.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('build-usage-data-inputs', () => {
  it('falls back to UTC when runtime timezone detection is unavailable', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: undefined as unknown as string,
    });

    const inputs = normalizeBuildUsageInputs({});

    expect(inputs.timezone).toBe('UTC');
  });

  it('normalizes provider filter to billing-entity value', () => {
    const inputs = normalizeBuildUsageInputs({
      provider: ' OpenAI-Codex ',
    });

    expect(inputs.providerFilter).toBe('openai');
  });

  it('infers fixed-provider roots from explicit model filters conservatively', () => {
    const inputs = normalizeBuildUsageInputs({
      model: [' GPT-5.2 ', 'gpt-4.1'],
    });

    expect(inputs.candidateProviderRoots).toEqual(['openai']);
  });

  it('intersects explicit provider and model provider roots when both are present', () => {
    const inputs = normalizeBuildUsageInputs({
      provider: 'google',
      model: ['gpt-5.2'],
    });

    expect(inputs.candidateProviderRoots).toEqual([]);
  });

  it('does not treat arbitrary provider substrings as canonical pruning roots', () => {
    const inputs = normalizeBuildUsageInputs({
      provider: 'ai',
    });

    expect(inputs.candidateProviderRoots).toBeUndefined();
  });

  it('treats source-dir overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      sourceDir: ['pi=/tmp/pi-sessions', 'codex=/tmp/codex-sessions'],
    });

    expect([...inputs.explicitSourceIds]).toEqual(['pi', 'codex']);
  });

  it('validates malformed source-dir entries through the shared parser', () => {
    expect(() => normalizeBuildUsageInputs({ sourceDir: ['invalid'] })).toThrow(
      '--source-dir must use format <source-id>=<path>',
    );
  });

  it('prunes only fixed-provider sources that cannot satisfy provider/model roots', () => {
    const adapters: SourceAdapter[] = [
      {
        id: 'pi',
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
      {
        id: 'codex',
        capabilities: { fixedProviderRoots: ['openai'] },
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
      {
        id: 'gemini',
        capabilities: { fixedProviderRoots: ['google'] },
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
    ];

    const selectedAdapters = selectAdaptersForParsing(adapters, {
      sourceFilter: undefined,
      candidateProviderRoots: ['openai'],
    });

    expect(selectedAdapters.map((adapter) => adapter.id)).toEqual(['pi', 'codex']);
  });
});
