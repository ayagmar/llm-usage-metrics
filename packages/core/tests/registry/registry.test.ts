import { describe, expect, it } from 'vitest';

import {
  canParseSourceOnWorker,
  createDefaultAdapters,
  createWorkerParseAdapter,
  getDefaultSourceIds,
  getSourceStorageFormat,
  sourceSupportsDirectories,
} from '../../src/registry/index.js';
import { ClaudeSourceAdapter } from '../../src/sources/claude/index.js';
import { MultiDirectorySourceAdapter } from '../../src/sources/multi-directory-source-adapter.js';
import { createSourceContext } from '../../src/sources/source-context.js';

const context = createSourceContext({ homeDir: '/home/tester', env: {}, platform: 'linux' });

describe('source registry', () => {
  it('reports each source storage format and rejects an unknown id', () => {
    expect(getSourceStorageFormat('codex')).toBe('jsonl');
    expect(getSourceStorageFormat('gemini')).toBe('json');
    expect(getSourceStorageFormat('opencode')).toBe('sqlite');
    expect(() => getSourceStorageFormat('nope')).toThrow('Unknown source id: nope');
  });

  it('tells directory-backed sources from single-file ones', () => {
    expect(sourceSupportsDirectories('pi')).toBe(true);
    expect(sourceSupportsDirectories('antigravity')).toBe(true);
    expect(sourceSupportsDirectories('opencode')).toBe(false);
    expect(sourceSupportsDirectories('goose')).toBe(false);
    expect(sourceSupportsDirectories('nope')).toBe(false);
  });

  it('parses only codex on workers, since pi and claude read their roots for fork parents', () => {
    const workerSources = getDefaultSourceIds().filter(canParseSourceOnWorker);

    expect(workerSources).toEqual(['codex']);
    expect(createWorkerParseAdapter('codex')?.id).toBe('codex');
    expect(createWorkerParseAdapter('pi')).toBeUndefined();
    expect(createWorkerParseAdapter('nope')).toBeUndefined();
  });

  it('builds one claude adapter over several roots, and one adapter per root otherwise', () => {
    const roots = ['/data/a', '/data/b'];
    const adapters = createDefaultAdapters(
      {
        sourceIds: ['pi', 'claude'],
        roots: new Map([
          ['pi', roots],
          ['claude', roots],
        ]),
      },
      context,
    );
    const [pi, claude] = adapters;

    expect(pi).toBeInstanceOf(MultiDirectorySourceAdapter);
    expect(claude).toBeInstanceOf(ClaudeSourceAdapter);
  });

  it('gives a single-file source only its first root', () => {
    const [opencode] = createDefaultAdapters(
      { sourceIds: ['opencode'], roots: new Map([['opencode', ['/db/one.db', '/db/two.db']]]) },
      context,
    );

    expect(opencode?.getSearchPaths?.()).toEqual(['/db/one.db']);
  });
});
