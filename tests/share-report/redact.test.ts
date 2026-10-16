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

  it('spells the home directory ~ and never climbs into or past it', () => {
    const home = '/home/alice';
    const keys = [home, `${home}/projects`, `${home}/app`, '/work/app', `${home}/a/x`, '/srv/a/x'];
    const labels = buildShareProjectLabels(keys, `${home}/`);

    // The report labels name the user: `alice`, and `alice/app` against `work/app`.
    expect(buildProjectLabels(keys).get(home)).toBe('alice');
    expect(Object.fromEntries(labels)).toEqual({
      [home]: '~',
      [`${home}/projects`]: 'projects',
      [`${home}/app`]: '~/app',
      '/work/app': 'work/app',
      [`${home}/a/x`]: '~/a/x',
      '/srv/a/x': 'srv/a/x',
    });
  });

  it('spells a Windows home ~ with forward slashes, and a sibling home ~ too', () => {
    const home = 'C:\\Users\\alice';
    const labels = buildShareProjectLabels(
      [home, `${home}\\app`, 'D:\\app', 'C:\\Users\\alice2'],
      home,
    );

    expect(labels.get(home)).toBe('~');
    expect(labels.get(`${home}\\app`)).toBe('~/app');
    expect(labels.get('D:\\app')).toBe('app');
    // Another user's home is a home all the same: it names that user.
    expect(labels.get('C:\\Users\\alice2')).toBe('~ #2');
  });

  it('spells any standard home ~, whatever machine the events came from', () => {
    const local = '/srv/me';
    const keys = [
      '/home/otheruser',
      '/home/otheruser/projects',
      '/home/otheruser/app',
      '/Users/bob',
      '/Users/bob/work/api',
      '/root/tools',
      '/var/home/carol/notes',
      'C:\\users\\Dev\\x',
      'd:/USERS/Eve/x',
      '/srv/me/site',
      '/work/app',
      '/home',
    ];
    const labels = buildShareProjectLabels(keys, local);
    const segments = [...labels.values()].flatMap((label) => label.split(/[ /]/u));

    for (const name of ['otheruser', 'bob', 'root', 'carol', 'Dev', 'Eve', 'me']) {
      expect(segments, name).not.toContain(name);
    }
    // Homes alike once spelled `~` stay apart: no two projects merge.
    expect(new Set(labels.values()).size).toBe(keys.length);
    expect([labels.get('/Users/bob'), labels.get('/home/otheruser')]).toEqual(['~', '~ #2']);
    expect(labels.get('/home/otheruser/projects')).toBe('projects');
    expect(labels.get('/home/otheruser/app')).toBe('~/app');
    expect(labels.get('/work/app')).toBe('work/app');
    expect(labels.get('/Users/bob/work/api')).toBe('api');
    expect(labels.get('/srv/me/site')).toBe('site');
    // Not a home: the folder holding them.
    expect(labels.get('/home')).toBe('home');
  });

  it('spells a home ~ under any root: WSL, Solaris, FreeBSD, a backup', () => {
    const keys = [
      '/mnt/c/Users/alicewsl',
      '/mnt/c/Users/alicewsl/proj',
      '/export/home/bobsolaris/app',
      '/usr/home/carolbsd',
      '/backup/home/dave/notes',
    ];
    const labels = buildShareProjectLabels(keys, '/srv/me');
    const segments = [...labels.values()].flatMap((label) => label.split(/[ /]/u));

    for (const name of ['alicewsl', 'bobsolaris', 'carolbsd', 'dave', 'mnt', 'export']) {
      expect(segments, name).not.toContain(name);
    }
    expect(labels.get('/mnt/c/Users/alicewsl/proj')).toBe('proj');
    expect(labels.get('/backup/home/dave/notes')).toBe('notes');
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

  it('spells the homes of other machines and users ~ in free text', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('ran in /home/otheruser/app and /Users/bob, then C:\\users\\Dev\\x')).toBe(
      'ran in ~/app and ~, then ~\\x',
    );
    expect(scrub('as /root on d:/USERS/Eve')).toBe('as ~ on ~');
    expect(scrub('on /mnt/c/Users/alicewsl and /export/home/bob')).toBe('on ~ and ~');
  });

  it('keeps a Windows profile name with a space inside the home it spells ~', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('logs in C:\\Users\\John Smith\\AppData\\x.log')).toBe(
      'logs in ~\\AppData\\x.log',
    );
    // A name with no separator after it ends at the space: the rest is prose.
    expect(scrub('as C:\\Users\\bob and D:')).toBe('as ~ and D:');
    expect(scrub('see /rooted and /homes/x')).toBe('see /rooted and /homes/x');
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
