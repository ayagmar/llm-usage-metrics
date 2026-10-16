import { describe, expect, it } from 'vitest';

import { buildProjectLabels } from '../../src/aggregate/project-key.js';
import {
  buildRedactionMap,
  buildShareProjectLabels,
  createPathScrubber,
  KEPT_MACHINE_LABELS,
  toShareModelLabel,
} from '../../src/share-report/redact.js';
import { sanitizeEmbeddedEnvelope } from '../../src/share-report/sanitize-envelope.js';

describe('buildShareProjectLabels', () => {
  it('numbers keys only their full path tells apart instead of showing the path', () => {
    const keys = ['C:\\work\\app', 'D:\\work\\app', '/w/a/api', '/w/b/api', undefined];

    // The report labels fall back to the full key for the two drives.
    expect(buildProjectLabels(keys).get('D:\\work\\app')).toBe('D:\\work\\app');
    expect(Object.fromEntries(buildShareProjectLabels(keys))).toEqual({
      'C:\\work\\app': 'work/app',
      'D:\\work\\app': 'work/app #2',
      '/w/a/api': 'a/api',
      '/w/b/api': 'b/api',
      undefined: '(unattributed)',
    });
  });

  it('skips numbered labels already taken and names a bare root', () => {
    const labels = buildShareProjectLabels(['/x/app', '/y/x/app', 'x/app #2', '/']);

    expect(new Set(labels.values()).size).toBe(4);
    expect(labels.get('/')).toBe('(root)');
    expect([...labels.values()].some((label) => label.startsWith('/'))).toBe(false);
  });
});

describe('toShareModelLabel', () => {
  it.each([
    ['/models/local/llama.gguf', 'llama.gguf'],
    ['~/models/qwen.gguf', 'qwen.gguf'],
    ['C:\\Models\\Mistral.GGUF', 'mistral.gguf'],
    ['\\\\server\\share\\m.bin', 'm.bin'],
    ['Claude-Sonnet-4-5', 'claude-sonnet-4-5'],
    ['openai/gpt-5', 'openai/gpt-5'],
    [undefined, '(unknown)'],
    ['  ', '(unknown)'],
  ])('labels %s as %s', (model, label) => {
    expect(toShareModelLabel(model)).toBe(label);
  });
});

describe('buildRedactionMap', () => {
  it('numbers by tokens, most first, ties by label, keeping local', () => {
    const map = buildRedactionMap(
      new Map([
        ['laptop', 10],
        ['local', 500],
        ['desk', 50],
        ['aaa', 10],
      ]),
      'machine',
      KEPT_MACHINE_LABELS,
    );

    expect([...map].sort()).toEqual([
      ['aaa', 'machine-2'],
      ['desk', 'machine-1'],
      ['laptop', 'machine-3'],
      ['local', 'local'],
    ]);
  });
});

describe('createPathScrubber', () => {
  it('replaces known paths, longest first, and reduces a whole path to its basename', () => {
    const scrub = createPathScrubber(
      new Map([
        ['/home/u', '~'],
        ['/home/u/work/app', 'app'],
      ]),
    );

    expect(scrub('commits in /home/u/work/app since May')).toBe('commits in app since May');
    expect(scrub('/home/u/other/repo')).toBe('repo');
    expect(scrub('plain text')).toBe('plain text');
  });
});

describe('sanitizeEmbeddedEnvelope', () => {
  const maps = {
    projectLabelForKey: (key: string | undefined) =>
      key === '/home/u/work/app' ? 'project-1' : key === undefined ? '(unattributed)' : undefined,
    projectLabelForLabel: (label: string) => (label === 'work/app' ? 'project-1' : undefined),
    machineLabel: (name: string) => (name === 'local' ? name : 'machine-1'),
    scrub: createPathScrubber(new Map([['/home/u/work/app', 'project-1']])),
  };

  it('drops path fields, maps projects and machines, and scrubs other strings', () => {
    const envelope = sanitizeEmbeddedEnvelope(
      {
        report: 'compare',
        data: {
          repoDir: '/home/u/work/app',
          projects: [
            { repoRoot: '/home/u/work/app', project: 'work/app', current: { totalTokens: 1 } },
            { repoRoot: null, project: '(unattributed)' },
            { project: 'work/app' },
          ],
          machine: 'desk',
          machines: ['local', 'desk'],
          note: 'read from /home/u/work/app',
          models: ['/opt/models/llama.gguf'],
          count: 3,
          flag: null,
        },
      },
      maps,
    );

    expect(envelope).toEqual({
      schemaVersion: 1,
      report: 'compare',
      data: {
        projects: [
          { project: 'project-1', current: { totalTokens: 1 } },
          { project: '(unattributed)' },
          { project: 'project-1' },
        ],
        machine: 'machine-1',
        machines: ['local', 'machine-1'],
        note: 'read from project-1',
        models: ['llama.gguf'],
        count: 3,
        flag: null,
      },
    });
  });
});
