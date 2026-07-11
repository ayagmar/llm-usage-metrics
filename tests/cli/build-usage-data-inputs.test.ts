import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeBuildUsageInputs,
  selectAdaptersForParsing,
  throwOnExplicitSourceScopeConflicts,
} from '../../src/cli/build-usage-data-inputs.js';
import { RuntimeProfileCollector } from '../../src/cli/runtime-profile.js';
import type { ReportCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { getSourceOverrideOptions } from '../../src/sources/create-default-adapters.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('build-usage-data-inputs', () => {
  it('uses the detected runtime timezone when no timezone option is set', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Africa/Casablanca',
    });

    const inputs = normalizeBuildUsageInputs({});

    expect(inputs.timezone).toBe('Africa/Casablanca');
  });

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
      sourceDir: [
        'pi=/tmp/pi-sessions',
        'codex=/tmp/codex-sessions',
        'copilot=/tmp/copilot-otel',
        'openclaw=/tmp/openclaw',
        'claude=/tmp/claude',
        'amp=/tmp/amp/threads',
        'qwen=/tmp/qwen/projects',
        'kimi=/tmp/kimi/sessions',
        'cline=/tmp/cline/tasks',
        'roocode=/tmp/roocode/tasks',
        'kilocode=/tmp/kilocode/tasks',
        'antigravity=/tmp/antigravity/conversations',
      ],
    });

    expect([...inputs.explicitSourceIds]).toEqual([
      'pi',
      'codex',
      'copilot',
      'openclaw',
      'claude',
      'amp',
      'qwen',
      'kimi',
      'cline',
      'roocode',
      'kilocode',
      'antigravity',
    ]);
  });

  it('treats openclaw directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      openclawDir: '/tmp/openclaw',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['openclaw']);
  });

  it('treats copilot directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      copilotDir: '/tmp/copilot-otel',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['copilot']);
  });

  it('treats goose DB overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      gooseDb: '/tmp/goose.db',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['goose']);
  });

  it('treats amp directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      ampDir: '/tmp/amp/threads',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['amp']);
  });

  it('treats qwen directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      qwenDir: '/tmp/qwen/projects',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['qwen']);
  });

  it('treats kimi directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      kimiDir: '/tmp/kimi/sessions',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['kimi']);
  });

  it('treats cline directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      clineDir: '/tmp/cline/tasks',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['cline']);
  });

  it('treats roocode directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      roocodeDir: '/tmp/roocode/tasks',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['roocode']);
  });

  it('treats kilocode directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      kilocodeDir: '/tmp/kilocode/tasks',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['kilocode']);
  });

  it('treats antigravity directory overrides as explicit source selections', () => {
    const inputs = normalizeBuildUsageInputs({
      antigravityDir: '/tmp/antigravity/conversations',
    });

    expect([...inputs.explicitSourceIds]).toEqual(['antigravity']);
  });

  it('treats every dedicated override option as an explicit source selection', () => {
    for (const overrideOption of getSourceOverrideOptions()) {
      const options = { [overrideOption.optionKey]: '/tmp/override' } as ReportCommandOptions;
      const inputs = normalizeBuildUsageInputs(options);

      expect([...inputs.explicitSourceIds]).toEqual([overrideOption.id]);
    }
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

  it('prunes kimi for other explicit providers and keeps it for moonshot', () => {
    const adapters: SourceAdapter[] = [
      {
        id: 'pi',
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
      {
        id: 'claude',
        capabilities: { fixedProviderRoots: ['anthropic'] },
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
      {
        id: 'kimi',
        capabilities: { fixedProviderRoots: ['moonshot'] },
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
    ];

    const anthropicInputs = normalizeBuildUsageInputs({ provider: 'anthropic' });
    const moonshotInputs = normalizeBuildUsageInputs({ provider: 'moonshot' });

    expect(
      selectAdaptersForParsing(adapters, {
        sourceFilter: undefined,
        candidateProviderRoots: anthropicInputs.candidateProviderRoots,
      }).map((adapter) => adapter.id),
    ).toEqual(['pi', 'claude']);
    expect(
      selectAdaptersForParsing(adapters, {
        sourceFilter: undefined,
        candidateProviderRoots: moonshotInputs.candidateProviderRoots,
      }).map((adapter) => adapter.id),
    ).toEqual(['pi', 'kimi']);
  });

  it('records source selection with candidate provider roots in the runtime profile', () => {
    const adapters: SourceAdapter[] = [
      {
        id: 'pi',
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
    const runtimeProfile = new RuntimeProfileCollector();

    selectAdaptersForParsing(adapters, {
      sourceFilter: undefined,
      candidateProviderRoots: ['google'],
      runtimeProfile,
    });

    expect(runtimeProfile.snapshot().sourceSelection).toEqual({
      availableSourceIds: ['pi', 'gemini'],
      selectedSourceIds: ['pi', 'gemini'],
      candidateProviderRoots: ['google'],
    });
  });

  it('uses provider/model wording when explicit source conflicts are raised without active flags', () => {
    const adapters: SourceAdapter[] = [
      {
        id: 'gemini',
        capabilities: { fixedProviderRoots: ['google'] },
        discoverFiles: async () => [],
        parseFile: async () => [],
      },
    ];

    expect(() => {
      throwOnExplicitSourceScopeConflicts(adapters, [], {
        explicitSourceIds: new Set(['gemini']),
        candidateProviderRoots: ['openai'],
        providerFilter: undefined,
        modelFilter: undefined,
      });
    }).toThrow(
      'Explicitly requested source(s) are incompatible with the requested provider/model scope: gemini.',
    );
  });
});
