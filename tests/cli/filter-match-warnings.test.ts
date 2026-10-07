import { describe, expect, it } from 'vitest';

import type { AdapterParseResult } from '../../src/cli/build-usage-data-parsing.js';
import { validateSourceFilterValues } from '../../src/cli/build-usage-data-inputs.js';
import { findUnmatchedFilterWarnings } from '../../src/cli/filter-match-warnings.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

function createResult(
  source: string,
  models: { model: string; provider?: string }[],
  filesFound = models.length,
): AdapterParseResult {
  return {
    source,
    filesFound,
    skippedRows: 0,
    skippedRowReasons: [],
    events: models.map(({ model, provider }) =>
      createUsageEvent({
        source,
        sessionId: 'session',
        timestamp: '2026-02-14T10:00:00.000Z',
        provider,
        model,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ),
  };
}

const parseResults = [
  createResult('claude', [{ model: 'claude-opus-5-5', provider: 'anthropic' }]),
  createResult('codex', [{ model: 'gpt-6.1-sol', provider: 'openai' }]),
  createResult('goose', [], 0),
];

describe('findUnmatchedFilterWarnings', () => {
  it('stays quiet without filters or when every filter matches', () => {
    expect(findUnmatchedFilterWarnings({ parseResults })).toEqual([]);
    expect(
      findUnmatchedFilterWarnings({
        parseResults,
        sourceFilter: new Set(['claude']),
        providerFilter: 'anthropic',
        modelFilter: ['claude-opus-5-5', 'gpt'],
      }),
    ).toEqual([]);
  });

  it('warns for each model value that matches nothing, with a close suggestion', () => {
    expect(
      findUnmatchedFilterWarnings({
        parseResults,
        modelFilter: ['claude-opsu-5-5', 'opus', 'llama'],
      }),
    ).toEqual([
      '--model claude-opsu-5-5 matched no usage (did you mean claude-opus-5-5?)',
      '--model llama matched no usage',
    ]);
  });

  it('warns for a provider that matches nothing', () => {
    expect(findUnmatchedFilterWarnings({ parseResults, providerFilter: 'antropic' })).toEqual([
      '--provider antropic matched no usage (did you mean anthropic?)',
    ]);
    expect(findUnmatchedFilterWarnings({ parseResults, providerFilter: 'google' })).toEqual([
      '--provider google matched no usage',
    ]);
  });

  it('warns for a selected source without files only while other sources have files', () => {
    expect(
      findUnmatchedFilterWarnings({ parseResults, sourceFilter: new Set(['claude', 'goose']) }),
    ).toEqual([
      '--source goose found no files; `llm-usage doctor --source goose` shows where it looks',
    ]);
    expect(
      findUnmatchedFilterWarnings({
        parseResults: [createResult('goose', [], 0)],
        sourceFilter: new Set(['goose']),
      }),
    ).toEqual([]);
  });
});

describe('validateSourceFilterValues', () => {
  it('suggests the closest source id for a typo', () => {
    const available = new Set(['claude', 'codex', 'pi']);

    expect(() => {
      validateSourceFilterValues(new Set(['cladue', 'zzz']), available);
    }).toThrow(
      'Unknown --source value(s): cladue (did you mean claude?), zzz. Allowed values: claude, codex, pi',
    );
  });
});
