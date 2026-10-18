import { describe, expect, it } from 'vitest';

import { buildProjectLabels } from '../../src/aggregate/project-key.js';
import {
  buildRedactionMap,
  buildShareProjectLabels,
  createNameReplacer,
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
    ['file:///opt/review-alice/models/private.gguf', 'private.gguf'],
    ['FILE://host/share/Models/m.bin', 'm.bin'],
    ['./models/home/oscar/m', 'm'],
    ['..\\Models\\Q.gguf', 'q.gguf'],
    ['mirror/home/oscar', '~'],
    ['hf:/opt/review-carol/models/colon.gguf', 'colon.gguf'],
    ['local:C:\\Models\\m.bin', 'm.bin'],
    ['Claude-Sonnet-4-5', 'claude-sonnet-4-5'],
    ['openrouter:anthropic/claude-sonnet-4-5', 'openrouter:anthropic/claude-sonnet-4-5'],
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
      'ran in app and ~, then x',
    );
    expect(scrub('as /root on d:/USERS/Eve')).toBe('as ~ on ~');
    expect(scrub('on /mnt/c/Users/alicewsl and /export/home/bob')).toBe('on ~ and ~');
    // Not homes, but paths all the same.
    expect(scrub('see /rooted and /homes/x')).toBe('see rooted and x');
  });

  it('reduces every path in free text to its basename, wherever it stands', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('review /opt/alice/private-data.json for x')).toBe(
      'review private-data.json for x',
    );
    expect(
      scrub('model="file:///opt/alice/m.gguf", dir=D:\\data\\alice (and \\\\nas\\alice\\x)'),
    ).toBe('model="m.gguf", dir=alice (and x)');
    expect(scrub('from ./alice/notes.md and ../bob/todo.txt; ~carol/x')).toBe(
      'from notes.md and todo.txt; x',
    );
    // Not paths: ratios, URLs, approximations, a lone slash.
    expect(scrub('tokens/s, https://example.test/a, ~5% and 1 / 2')).toBe(
      'tokens/s, https://example.test/a, ~5% and 1 / 2',
    );
  });

  it('keeps known paths as their labels, under redaction too', () => {
    const scrub = createPathScrubber(new Map([['/srv/private-project', 'project-1']]));

    expect(scrub('edited /srv/private-project/src/a.ts')).toBe('edited project-1/src/a.ts');
  });

  it('keeps a Windows profile name with a space inside the home it spells ~', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('logs in C:\\Users\\John Smith\\AppData\\x.log')).toBe('logs in x.log');
    expect(scrub('logs in C:/Users/John Smith/AppData/x.log')).toBe('logs in x.log');
    expect(scrub('logs in /Users/John Smith/AppData/x.log')).toBe('logs in x.log');
    // A name with no separator after it ends at the space: the rest is prose.
    expect(scrub('as C:\\Users\\bob and D:')).toBe('as ~ and D:');
    expect(scrub('as /Users/bob and also /tmp/x')).toBe('as ~ and also x');
  });

  it('drops all of a spaced profile name with nothing after it, and its capitalised words in prose', () => {
    const scrub = createPathScrubber(new Map());

    // At the end of the value the whole spaced segment is the name.
    expect(scrub('C:/Users/John Smith')).toBe('~');
    expect(scrub('C:\\Users\\John Smith')).toBe('~');
    expect(scrub('home: /Users/John Smith')).toBe('home: ~');
    expect(scrub('home: /Users/john smith')).toBe('home: ~');
    expect(scrub('/Users/John Smith went home')).toBe('~');
    // Before other text, capitalised words after the name go with it: they may be a surname.
    expect(scrub('opened /Users/John Smith in Finder, then /tmp/x')).toBe(
      'opened ~ in Finder, then x',
    );
    // With no separator after it, a name runs to the end of the text (`;` may be in a name).
    expect(scrub('at /Users/Jane Doe, then C:\\Users\\Ann Lee; done')).toBe('at ~, then ~');
    expect(scrub('as /Users/bob C:\\x')).toBe('as ~ x');
  });

  it('reduces paths after a pipe, an angle bracket or a guillemet', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('x|/opt/alice/y')).toBe('x|y');
    expect(scrub('x>/opt/alice/y')).toBe('x>y');
    expect(scrub('«/opt/alice/y»')).toBe('«y»');
  });

  it('runs a drive path with spaces to its last separator', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('run C:\\Program Files\\alice\\x.exe now')).toBe('run x.exe now');
    expect(scrub('run D:/Program Files/alice/x.exe now')).toBe('run x.exe now');
    expect(scrub('in C:\\a b\\c and D:\\e\\f')).toBe('in c and f');
    expect(scrub('in C:\\Program Files (x86)\\alice\\x.exe')).toBe('in x.exe');
  });

  it('reduces a path after a colon, but leaves URLs alone', () => {
    const scrub = createPathScrubber(new Map());

    expect(scrub('location:/opt/private-user/a.json')).toBe('location:a.json');
    expect(scrub('at:C:\\data\\alice\\b.json, at:~/alice/c.md')).toBe('at:b.json, at:c.md');
    expect(scrub('see https://example.test/a and file:///opt/alice/m.gguf')).toBe(
      'see https://example.test/a and m.gguf',
    );
  });
});

describe('createNameReplacer', () => {
  it('replaces whole-word names, longest first, never a replacement again', () => {
    const replace = createNameReplacer(
      new Map([
        ['app', 'project-2'],
        ['work/app', 'project-1'],
        ['project-1', 'project-3'],
        ['desk', 'machine-1'],
        ['~', 'project-4'],
        ['local', 'local'],
      ]),
    );

    expect(replace('work/app and app on desk, not desktop or app-server; ~ and local')).toBe(
      'project-1 and project-2 on machine-1, not desktop or app-server; ~ and local',
    );
    expect(replace('app.')).toBe('project-2.');
    expect(replace('nothing here')).toBe('nothing here');
  });
});

describe('sanitizeEmbeddedEnvelope', () => {
  const maps = {
    projectLabelForKey: (key: string | undefined) =>
      key === '/home/u/work/app' ? 'project-1' : key === undefined ? '(unattributed)' : undefined,
    projectLabelForLabel: (label: string) => (label === 'work/app' ? 'project-1' : undefined),
    machineLabel: (name: string) => (name === 'local' ? name : 'machine-1'),
    modelLabel: toShareModelLabel,
    scrub: createPathScrubber(new Map([['/home/u/work/app', 'project-1']])),
    names: new Map<string, string>(),
  };

  it('replaces in free text the names the fields and the maps give', () => {
    const envelope = sanitizeEmbeddedEnvelope(
      {
        report: 'compare',
        data: {
          rows: [{ project: 'work/app', machine: 'desk' }],
          note: 'work/app ran on desk and on laptop',
        },
      },
      { ...maps, names: new Map([['laptop', 'machine-2']]) },
    );

    expect(envelope.data).toEqual({
      rows: [{ project: 'project-1', machine: 'machine-1' }],
      note: 'project-1 ran on machine-1 and on machine-2',
    });
  });

  it('leaves identifiers alone when a project or machine shares their name', () => {
    const names = new Map([
      ['codex', 'project-1'],
      ['tokens', 'project-2'],
      ['openai', 'machine-1'],
      ['ALL', 'project-3'],
    ]);
    const data = {
      sources: [{ source: 'codex', provider: 'openai', periodKey: 'ALL' }],
      metrics: [{ key: 'inputTokens', label: 'Input tokens', valueType: 'integer' }],
      topSources: [{ name: 'codex', totalTokens: 1 }],
      notes: ['missing_pricing'],
    };

    expect(sanitizeEmbeddedEnvelope({ report: 'compare', data }, { ...maps, names }).data).toEqual(
      data,
    );
  });

  it('keeps trends’ metric and summary’s dates when a project is named like them', () => {
    const names = new Map([
      ['tokens', 'project-1'],
      ['2026', 'project-2'],
      ['06', 'project-3'],
    ]);
    const data = {
      metric: 'tokens',
      dateRange: { from: '2026-06-01', to: '2026-06-21' },
      totalSeries: { buckets: [{ date: '2026-06-15', value: 3 }] },
      periods: [{ key: 'today', since: '2026-06-21', until: '2026-06-21' }],
    };

    expect(sanitizeEmbeddedEnvelope({ report: 'trends', data }, { ...maps, names }).data).toEqual(
      data,
    );
  });

  it('replaces names only in free text, never in a month, date or metric', () => {
    // Projects labelled like a period key and a metric, as the file shows them under --redact.
    const names = new Map([
      ['2026-10', 'project-1'],
      ['tokens', 'project-2'],
    ]);
    const data = {
      metric: 'tokens',
      monthlyIntensity: [{ month: '2026-10', totalTokens: 5 }],
      dailyIntensity: [{ date: '2026-10-01', totalTokens: 5 }],
      totalSeries: { buckets: [{ date: '2026-10', value: 'tokens' }] },
      periods: [{ key: '2026-10', label: '2026-10', since: '2026-10-01', until: '2026-10-31' }],
      newField: '2026-10 tokens',
      note: 'most tokens went to 2026-10',
      warnings: ['2026-10 lacks pricing'],
    };

    expect(sanitizeEmbeddedEnvelope({ report: 'wrapped', data }, { ...maps, names }).data).toEqual({
      ...data,
      note: 'most project-2 went to project-1',
      warnings: ['project-1 lacks pricing'],
    });
  });

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
          topModels: [{ name: './models/home/oscar/M', totalTokens: 2 }],
          candidateModel: '~/models/Qwen.gguf',
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
        topModels: [{ name: 'm', totalTokens: 2 }],
        candidateModel: 'qwen.gguf',
        count: 3,
        flag: null,
      },
    });
  });
});
