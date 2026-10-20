import { describe, expect, it } from 'vitest';

import {
  buildEventProjectLabels,
  buildProjectLabels,
  toProjectKey,
} from '../../src/aggregate/project-key.js';

function labelsOf(keys: (string | undefined)[]): Record<string, string> {
  return Object.fromEntries(
    [...buildProjectLabels(keys)].map(([key, label]) => [String(key), label]),
  );
}

describe('toProjectKey', () => {
  it('strips trailing separators but keeps a bare root and the raw separators', () => {
    expect(toProjectKey('/w/a/api/')).toBe('/w/a/api');
    expect(toProjectKey('/w/a/api//')).toBe('/w/a/api');
    expect(toProjectKey('C:\\src\\web\\')).toBe('C:\\src\\web');
    expect(toProjectKey('/')).toBe('/');
    expect(toProjectKey('C:\\')).toBe('C:\\');
    expect(toProjectKey('C:/')).toBe('C:/');
    expect(toProjectKey(undefined)).toBeUndefined();
  });

  it('counts a directory inside node_modules as the project that holds it', () => {
    expect(
      toProjectKey('/w/app/node_modules/.pnpm/astro@7_x/node_modules/@astrojs/starlight/dist'),
    ).toBe('/w/app');
    expect(toProjectKey('/w/app/site/node_modules/')).toBe('/w/app/site');
    expect(toProjectKey('C:\\src\\web\\node_modules\\pkg')).toBe('C:\\src\\web');
    expect(toProjectKey('/w/node_modules_tools/src')).toBe('/w/node_modules_tools/src');
    expect(toProjectKey('/node_modules/pkg')).toBe('/');
    expect(toProjectKey('C:\\node_modules\\pkg')).toBe('C:\\');
    expect(toProjectKey('/w/node_modules_cache/app/node_modules/dep')).toBe(
      '/w/node_modules_cache/app',
    );
  });

  it('counts a Claude Code worktree, or a directory inside one, as its repository', () => {
    expect(toProjectKey('/w/app/.claude/worktrees/fix-login')).toBe('/w/app');
    expect(toProjectKey('/w/app/.claude/worktrees/fix-login/')).toBe('/w/app');
    expect(toProjectKey('/w/app/.claude/worktrees/fix-login/src/cli')).toBe('/w/app');
    expect(toProjectKey('C:\\src\\app\\.claude\\worktrees\\fix\\src')).toBe('C:\\src\\app');
    expect(toProjectKey('/w/app/.claude/worktrees/fix/node_modules/dep')).toBe('/w/app');
    expect(toProjectKey('/.claude/worktrees/fix')).toBe('/');
    expect(toProjectKey('/w/app//.claude/worktrees/fix')).toBe('/w/app');
    expect(toProjectKey('/w/app//node_modules/dep')).toBe('/w/app');
    expect(toProjectKey('/w/app/.claude/worktrees')).toBe('/w/app/.claude/worktrees');
    expect(toProjectKey('/w/app/.claude/worktrees/')).toBe('/w/app/.claude/worktrees');
    expect(toProjectKey('/w/app/worktrees/fix')).toBe('/w/app/worktrees/fix');
    expect(toProjectKey('/w/app/.git/worktrees/fix')).toBe('/w/app/.git/worktrees/fix');
    expect(toProjectKey('/w/app/my.claude/worktrees/fix')).toBe('/w/app/my.claude/worktrees/fix');
  });
});

describe('buildProjectLabels', () => {
  it('labels each key with its last segment when that is unique', () => {
    expect(labelsOf(['/w/a/api', '/w/b/web', 'C:\\src\\tools'])).toEqual({
      '/w/a/api': 'api',
      '/w/b/web': 'web',
      'C:\\src\\tools': 'tools',
    });
  });

  it('adds parent segments to colliding labels until they are unique', () => {
    expect(labelsOf(['/w/a/api', '/w/b/api', '/x/b/api', '/w/web'])).toEqual({
      '/w/a/api': 'a/api',
      '/w/b/api': 'w/b/api',
      '/x/b/api': 'x/b/api',
      '/w/web': 'web',
    });
  });

  it('extends a collision across separators, joining labels with /', () => {
    expect(labelsOf(['/w/a/api', 'C:\\src\\b\\api'])).toEqual({
      '/w/a/api': 'a/api',
      'C:\\src\\b\\api': 'b/api',
    });
  });

  it('uses the full key for keys that run out of segments while colliding', () => {
    expect(labelsOf(['/api', 'C:\\api'])).toEqual({ '/api': '/api', 'C:\\api': 'C:\\api' });
    // The longer key can still extend.
    expect(labelsOf(['/api', '/w/api'])).toEqual({ '/api': '/api', '/w/api': 'w/api' });
  });

  it('labels bare roots with the full key and missing roots as (unattributed)', () => {
    expect(labelsOf(['/', 'C:\\', undefined])).toEqual({
      '/': '/',
      'C:\\': 'C:\\',
      undefined: '(unattributed)',
    });
  });

  it('never gives a real project the (unattributed) label', () => {
    expect(labelsOf([undefined, '/w/(unattributed)'])).toEqual({
      undefined: '(unattributed)',
      '/w/(unattributed)': 'w/(unattributed)',
    });
    // Reserved even when no event lacks a root, so a label never reads as missing roots.
    expect(labelsOf(['/w/(unattributed)'])).toEqual({ '/w/(unattributed)': 'w/(unattributed)' });
    expect(labelsOf(['/(unattributed)'])).toEqual({ '/(unattributed)': '/(unattributed)' });
    // A rootless key with no parent segment to add.
    expect(labelsOf([undefined, '(unattributed)'])).toEqual({
      undefined: '(unattributed)',
      '(unattributed)': './(unattributed)',
    });
  });

  it('gives every distinct key a distinct label, whatever the order or repeats', () => {
    const keys = ['/a/x/api', '/b/x/api', '/api', '/c/api', 'D:\\x\\api', '/a/x/api', undefined];
    const labels = buildProjectLabels(keys);
    const reversed = buildProjectLabels([...keys].reverse());

    expect(labels.size).toBe(6);
    expect(new Set(labels.values()).size).toBe(6);
    expect([...reversed].sort()).toEqual([...labels].sort());
  });

  it('never reuses a label already given, a fallback included', () => {
    for (const third of ['/./(unattributed)', './(unattributed)']) {
      const keys = [undefined, '(unattributed)', third];
      const labels = labelsOf(keys);

      expect(new Set(Object.values(labels)).size, third).toBe(3);
      expect(labelsOf([...keys].reverse())).toEqual(labels);
    }

    expect(labelsOf([undefined, '(unattributed)', '/./(unattributed)'])).toEqual({
      undefined: '(unattributed)',
      '(unattributed)': './(unattributed)',
      '/./(unattributed)': '/./(unattributed)',
    });
    // Even the full key is taken: numbered, as elsewhere.
    expect(labelsOf([undefined, '(unattributed)', './(unattributed)'])).toEqual({
      undefined: '(unattributed)',
      '(unattributed)': './(unattributed)',
      './(unattributed)': './(unattributed) #2',
    });
  });
});

/** Deterministic pseudo-random numbers (mulberry32). */
function createRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEGMENTS = ['.', '..', '(unattributed)', 'a', 'b'];
const PREFIXES = ['', '/', './', 'C:\\'];

/** A relative or absolute root of one to three segments, short ones the most likely. */
function randomKey(random: () => number): string {
  const pick = <Item>(items: readonly Item[]) => items[Math.floor(random() * items.length)];
  const length = random() < 0.5 ? 1 : random() < 0.7 ? 2 : 3;
  const prefix = pick(PREFIXES);
  const segments = Array.from({ length }, () => pick(SEGMENTS));

  return `${prefix}${segments.join(prefix === 'C:\\' ? '\\' : '/')}`;
}

describe('project label properties', () => {
  it('labels distinct keys distinctly, keeps (unattributed) for missing roots, ignores order', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const random = createRandom(seed);
      const keys: (string | undefined)[] = Array.from(
        { length: 1 + Math.floor(random() * 16) },
        () => (random() < 0.1 ? undefined : randomKey(random)),
      );
      const labels = buildProjectLabels(keys);
      const message = `seed ${String(seed)}: ${JSON.stringify(keys)}`;

      expect(labels.size, message).toBe(new Set(keys).size);
      expect(new Set(labels.values()).size, message).toBe(labels.size);

      for (const [key, label] of labels) {
        expect(label === '(unattributed)', message).toBe(key === undefined);
      }

      expect([...buildProjectLabels([...keys].reverse())].sort(), message).toEqual(
        [...labels].sort(),
      );
    }
  });

  it('labels a key by its last segment when no other key shares it', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = createRandom(seed);
      const keys = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => `/w/${['api', 'web', 'cli', 'docs', 'site', 'core'][Math.floor(random() * 6)]}`,
      );
      const labels = buildProjectLabels(keys);

      for (const key of keys) {
        expect(labels.get(key)).toBe(key.slice('/w/'.length));
      }
    }
  });
});

describe('buildEventProjectLabels', () => {
  it('labels the keys of the events, trailing separators folded and missing roots unattributed', () => {
    const labels = buildEventProjectLabels([
      { repoRoot: '/w/a/api/' },
      { repoRoot: '/w/b/api' },
      {},
    ]);

    expect(labels).toEqual(
      buildProjectLabels([toProjectKey('/w/a/api'), toProjectKey('/w/b/api'), undefined]),
    );
    expect(labels.get(undefined)).toBe('(unattributed)');
  });
});
