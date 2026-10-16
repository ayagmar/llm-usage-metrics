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
