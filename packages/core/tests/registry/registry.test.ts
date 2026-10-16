import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canParseSourceOnWorker,
  createDefaultAdapters,
  createWorkerParseAdapter,
  getDefaultSourceIds,
  getParseWorkerRoots,
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

  it('parses claude, codex and pi on workers, over the roots each task carries', () => {
    const workerSources = getDefaultSourceIds().filter(canParseSourceOnWorker);

    expect(workerSources).toEqual(['pi', 'codex', 'claude']);
    // One adapter over every root, never re-resolved from the worker's own home.
    expect(createWorkerParseAdapter('pi', ['/data/a', '/data/b'])?.getSearchPaths?.()).toEqual([
      '/data/a',
      '/data/b',
    ]);
    expect(createWorkerParseAdapter('claude', ['/data/a'])?.getSearchPaths?.()).toEqual([
      '/data/a',
    ]);
    expect(createWorkerParseAdapter('codex', ['/data/codex'])?.getSearchPaths?.()).toEqual([
      '/data/codex',
    ]);
    expect(createWorkerParseAdapter('gemini', ['/data/a'])).toBeUndefined();
    expect(createWorkerParseAdapter('nope', [])).toBeUndefined();
  });

  it('sends a worker the roots of the directory that owns the file', async () => {
    const [pi] = createDefaultAdapters(
      { sourceIds: ['pi'], roots: new Map([['pi', ['/data/a', '/data/b']]]) },
      context,
    );
    const [claude] = createDefaultAdapters(
      { sourceIds: ['claude'], roots: new Map([['claude', ['/data/a', '/data/b']]]) },
      context,
    );
    const [defaultPi] = createDefaultAdapters({ sourceIds: ['pi'] }, context);

    // Undiscovered files fall back to the first directory, as reads do.
    expect(getParseWorkerRoots(pi, '/data/b/x.jsonl')).toEqual(['/data/a']);
    expect(getParseWorkerRoots(claude, '/data/b/x.jsonl')).toEqual(['/data/a', '/data/b']);
    expect(getParseWorkerRoots(defaultPi, '/x.jsonl')).toEqual([
      path.join('/home/tester', '.pi', 'agent', 'sessions'),
      path.join('/home/tester', '.omp', 'agent', 'sessions'),
    ]);
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

    expect(opencode.getSearchPaths?.()).toEqual(['/db/one.db']);
  });
});
