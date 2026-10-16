import type * as ChildProcess from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import { createCli } from '../../src/cli/create-cli.js';
import { getSourceOverrideOptions } from '../../src/cli/source-cli-options.js';
import type { ReportCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { SVG_NAMESPACE } from '../../src/share-report/client/ui/export/svg-export.js';
import { deleteMachineCache } from '../../src/machines/machine-cache.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import type { ShareReportData, ShareReportMeta } from '../../src/share-report/types.js';
import {
  ALL_SOURCE_IDS,
  captureStdout,
  createE2eSourceOptions,
  FIXED_NOW,
  WINDOWS_SKIP_REASON,
  type SourceOptions,
} from '../golden/golden-harness.js';
import { createGitFixtureRepo, isolatedGitEnv } from '../helpers/git-fixtures.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { compileReportValidators } from '../helpers/report-schema-validation.js';
import {
  cspHash,
  cspSource,
  markupOnly,
  readParts,
  readSharePayload,
} from '../helpers/share-html.js';

// A configured machine is read from its synced cache only; real ssh must never run here.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const spawn = new Proxy(actual.spawn, {
    apply(target, thisArg, args: unknown[]) {
      if (args[0] === 'ssh') {
        throw new Error('ssh must not run in the share report e2e');
      }

      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });

  return { ...actual, spawn };
});

type ShareCase = {
  args: string[];
  /** `--source`; every source by default. */
  source?: string;
  fileName: string;
  command: ShareReportMeta['command'];
  window: ShareReportMeta['window'];
  initialView: ShareReportMeta['initialView'];
  envelope?: NonNullable<ShareReportData['envelope']>['report'];
};

// FIXED_NOW is Sunday 2026-06-21 (UTC); the e2e fixtures hold events from 2026-01 to 2026-06-20.
const SHARE_CASES: ShareCase[] = [
  {
    args: ['daily'],
    fileName: 'usage-daily-share.html',
    command: 'daily',
    // The default window: the last 7 days, open-ended.
    window: { since: '2026-06-15', until: null },
    initialView: { since: '2026-06-15', until: null, granularity: 'day' },
  },
  {
    args: ['weekly'],
    fileName: 'usage-weekly-share.html',
    command: 'weekly',
    // The last 8 ISO weeks, from the Monday 7 weeks before this week's.
    window: { since: '2026-04-27', until: null },
    initialView: { since: '2026-04-27', until: null, granularity: 'week' },
  },
  {
    args: ['monthly', '--by-machine', '--by-repo'],
    fileName: 'usage-monthly-share.html',
    command: 'monthly',
    window: { since: null, until: null },
    initialView: { since: null, until: null, granularity: 'month' },
  },
  {
    args: ['summary'],
    fileName: 'summary-share.html',
    command: 'summary',
    // The activity grid: 53 ISO weeks ending today.
    window: { since: '2025-06-16', until: '2026-06-21' },
    initialView: { since: '2025-06-16', until: '2026-06-21', granularity: 'week' },
  },
  {
    args: ['compare'],
    fileName: 'compare-share.html',
    command: 'compare',
    // Month to date against the same days of May: the file spans both, opening on June.
    window: { since: '2026-05-01', until: '2026-06-21' },
    initialView: { since: '2026-06-01', until: '2026-06-21', granularity: 'day' },
    envelope: 'compare',
  },
  {
    args: ['trends', '--by-source'],
    fileName: 'trends-share.html',
    command: 'trends',
    window: { since: '2026-05-23', until: '2026-06-21' },
    initialView: { since: '2026-05-23', until: '2026-06-21', granularity: 'day' },
  },
  {
    args: ['efficiency', 'weekly', '--since', '2026-01-01', '--until', '2026-06-21'],
    fileName: 'efficiency-weekly-share.html',
    command: 'efficiency',
    window: { since: '2026-01-01', until: '2026-06-21' },
    initialView: { since: '2026-01-01', until: '2026-06-21', granularity: 'week' },
    envelope: 'efficiency',
  },
  {
    args: ['optimize', 'monthly', '--provider', 'openai', '--candidate-model', 'gpt-4.1'],
    // Optimize compares one provider; some sources can never be openai.
    source: 'pi,codex',
    fileName: 'optimize-monthly-share.html',
    command: 'optimize',
    window: { since: null, until: null },
    initialView: { since: null, until: null, granularity: 'month' },
    envelope: 'optimize',
  },
  {
    args: ['wrapped'],
    fileName: 'llm-usage-wrapped-2026.html',
    command: 'wrapped',
    // Wrapped's year, all of it.
    window: { since: '2026-01-01', until: '2026-12-31' },
    initialView: { since: '2026-01-01', until: '2026-12-31', granularity: 'week' },
    envelope: 'wrapped',
  },
];

// Session IDs shorter than this could occur by chance in the minified client.
const MIN_SCANNED_SESSION_ID_LENGTH = 8;

/** `--source` and the directory flag of each of its sources. */
function toSourceArgs(sources: SourceOptions, source: string): string[] {
  const ids = source.split(',');

  return [
    '--source',
    source,
    ...getSourceOverrideOptions().flatMap((option) => {
      const values = ids.includes(option.id) ? [sources[option.optionKey] ?? []].flat() : [];
      return values.flatMap((value) => [option.flag.split(' ')[0], value]);
    }),
  ];
}

/** Strings no share file may hold (decision 18): paths, the home directory, session IDs. */
type ForbiddenStrings = {
  paths: string[];
  sessionIds: string[];
  /** The names of the home directories in the events (the local one and any standard one). */
  homeNames: string[];
};

// A home directory by its standard layout, on this machine or another one.
const HOME_LAYOUT_PATTERN = /[\\/](?:home|Users)[\\/]([^\\/]+)/iu;

/**
 * The user name a standard home directory in `repoRoot` gives away, if any. The local home
 * (the temp root's `home` folder here) is scanned for by its own name.
 */
function homeLayoutName(repoRoot: string): string | undefined {
  if (repoRoot.startsWith(os.homedir())) {
    return undefined;
  }

  return repoRoot === '/root' || repoRoot.startsWith('/root/')
    ? 'root'
    : HOME_LAYOUT_PATTERN.exec(repoRoot)?.[1];
}

/** A local model logged by its file URI; the file shows only its basename. */
const FILE_URI_MODEL = 'file:///opt/review-alice/models/private.gguf';

/**
 * Claude rows run from the home directory and from a folder under it, beside a namesake, and
 * from the homes of other machines (as their events carry them). The last one ran a local
 * model named by its file URI.
 */
function homeClaudeRows(): string {
  const roots = [
    os.homedir(),
    path.join(os.homedir(), 'app'),
    '/work/app',
    '/home/otheruser/app',
    '/Users/bob',
    'C:\\users\\Dev\\winproj',
    '/mnt/c/Users/alicewsl/wslrepo',
    '/export/home/bobsolaris',
  ];

  return roots
    .map((cwd, index) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: `2026-06-20T1${String(index)}:30:00.000Z`,
        sessionId: `claude-home-session-${String(index)}`,
        cwd,
        uuid: `claude-home-row-${String(index)}`,
        message: {
          id: `claude-home-msg-${String(index)}`,
          role: 'assistant',
          model: index === roots.length - 1 ? FILE_URI_MODEL : 'claude-sonnet-4-5',
          usage: { input_tokens: 30, output_tokens: 10 },
        },
      }),
    )
    .join('\n');
}

/** Every project label in the payload: its dictionary and the envelope's `project` fields. */
function collectProjectLabels(data: ShareReportData): string[] {
  const labels = [...data.dictionaries.projects];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, field] of Object.entries(value)) {
        if (key === 'project' && typeof field === 'string') {
          labels.push(field);
        }
        visit(field);
      }
    }
  };

  visit(data.envelope?.data);
  return labels;
}

function expectSelfContained(html: string): void {
  const parts = readParts(html);
  const markup = markupOnly(html);
  const csp = html.indexOf('Content-Security-Policy');

  // CSP first, and only the embedded script and style may run.
  expect(csp).toBeGreaterThan(0);
  expect(csp).toBeLessThan(html.indexOf('<style'));
  expect(csp).toBeLessThan(html.indexOf('<script'));
  expect(cspSource(parts.csp, 'default-src')).toBe("'none'");
  expect(cspSource(parts.csp, 'script-src')).toBe(`'${cspHash(parts.script)}'`);
  expect(cspSource(parts.csp, 'style-src')).toBe(`'${cspHash(parts.style)}'`);
  expect(markup.match(/<script>/gu)).toHaveLength(1);
  expect(html).not.toMatch(/\sstyle\s*=/iu);
  expect(markup).not.toMatch(/\son[a-z]+\s*=/iu);

  // No URL but the SVG namespace, which is never fetched.
  const urls = html.match(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>)\\]*/giu) ?? [];
  expect(urls.filter((url) => url !== SVG_NAMESPACE)).toEqual([]);
  expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?\/\//iu);
}

function expectNoForbiddenStrings(html: string, forbidden: ForbiddenStrings): void {
  for (const value of forbidden.paths) {
    expect(html, 'a path').not.toContain(value);
  }

  for (const id of forbidden.sessionIds) {
    expect(html, 'a session ID').not.toContain(id);
  }

  // Path-like text anywhere in the file: a home or temp directory, a drive or UNC root.
  expect(html).not.toMatch(/(?:\/home\/|\/Users\/|\/tmp\/|\/private\/|[A-Za-z]:\\\\|\\\\\\\\)/u);

  // Every home directory is `~`: no label names one or climbs into one.
  const segments = collectProjectLabels(readSharePayload(html).data).flatMap((label) =>
    label.split(/[ /]/u),
  );
  for (const name of forbidden.homeNames) {
    expect(segments, 'a home directory name').not.toContain(name);
  }
}

describe.skipIf(process.platform === 'win32')(`share report e2e (${WINDOWS_SKIP_REASON})`, () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  let sources: SourceOptions;
  let sourceOptions: ReportCommandOptions;
  let repoDir: string;
  let forbidden: ForbiddenStrings;
  let validators: Map<string, ValidateFunction>;

  /** Runs `llm-usage <args> --share --no-open` in a fresh directory; returns its files. */
  async function runShare(
    name: string,
    args: string[],
    source = ALL_SOURCE_IDS.join(','),
  ): Promise<Map<string, string>> {
    const cwd = await mkdtemp(path.join(environment.rootDir, `cwd-${name}-`));
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      await captureStdout(async () => {
        await createCli().parseAsync([
          'node',
          'llm-usage',
          ...args,
          ...toSourceArgs(sources, source),
          '--timezone',
          'UTC',
          '--pricing-offline',
          '--no-sync',
          '--share',
          '--no-open',
        ]);
      });
    } finally {
      process.chdir(previousCwd);
    }

    const names = await readdir(cwd);
    return new Map(
      await Promise.all(
        names.map(
          async (fileName) => [fileName, await readFile(path.join(cwd, fileName), 'utf8')] as const,
        ),
      ),
    );
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);

    sources = await createE2eSourceOptions(environment.rootDir);
    const homeProjectDir = path.join(sources.claudeDir as string, 'home-projects');
    await mkdir(homeProjectDir);
    await writeFile(path.join(homeProjectDir, 'session.jsonl'), homeClaudeRows());
    sourceOptions = { ...sources, source: ALL_SOURCE_IDS.join(','), timezone: 'UTC' };

    // efficiency reads git outcomes from --repo-dir.
    const git = await createGitFixtureRepo(path.join(environment.rootDir, 'git'), [
      { date: '2026-06-10T10:00:00Z', message: 'feat: one', files: { 'a.txt': 'a\n' } },
    ]);
    repoDir = git.repoDir;
    for (const [name, value] of Object.entries(isolatedGitEnv(git.globalConfigPath))) {
      vi.stubEnv(name, value);
    }

    const dataset = await buildUsageEventDataset({ ...sourceOptions, sync: false }, {});
    const repoRoots = new Set(dataset.filteredEvents.flatMap((event) => event.repoRoot ?? []));
    const sessionIds = new Set(dataset.filteredEvents.map((event) => event.sessionId));
    const projectNames = new Set([...repoRoots].map((repoRoot) => path.basename(repoRoot)));

    expect(repoRoots).toContain(os.homedir());
    expect([...repoRoots].flatMap((repoRoot) => homeLayoutName(repoRoot) ?? [])).toEqual(
      expect.arrayContaining(['otheruser', 'bob', 'Dev', 'alicewsl', 'bobsolaris']),
    );
    forbidden = {
      paths: [...repoRoots, os.homedir(), environment.rootDir, repoDir, FILE_URI_MODEL],
      homeNames: [
        path.basename(os.homedir()),
        ...[...repoRoots].flatMap((repoRoot) => homeLayoutName(repoRoot) ?? []),
      ],
      // A fixture session may be named like its project, whose label the file does show.
      sessionIds: [...sessionIds].filter(
        (id) => id.length >= MIN_SCANNED_SESSION_ID_LENGTH && !projectNames.has(id),
      ),
    };
    expect(forbidden.sessionIds.length).toBeGreaterThan(0);
    validators = compileReportValidators();
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(SHARE_CASES)('$args.0 writes one self-contained $fileName', async (shareCase) => {
    const args =
      shareCase.command === 'efficiency'
        ? [...shareCase.args, '--repo-dir', repoDir]
        : shareCase.args;
    const files = await runShare(shareCase.command, args, shareCase.source);

    expect([...files.keys()]).toEqual([shareCase.fileName]);
    const html = files.get(shareCase.fileName) ?? '';
    const payload = readSharePayload(html);

    expect(
      validators.get('share')?.(payload),
      JSON.stringify(validators.get('share')?.errors),
    ).toBe(true);
    expect(payload.data.meta).toMatchObject({
      command: shareCase.command,
      window: shareCase.window,
      initialView: shareCase.initialView,
      redacted: false,
    });
    expect(payload.data.envelope?.report).toBe(shareCase.envelope);
    // No fixture usage is in --repo-dir's repository, so efficiency counts none and nor does its file.
    const events = payload.data.cube.eventCount.reduce((sum, count) => sum + count, 0);
    expect(shareCase.command === 'efficiency' ? events === 0 : events > 0).toBe(true);
    expectSelfContained(html);
    expectNoForbiddenStrings(html, forbidden);
  });

  /** Every project label and machine name of `plain` the redacted `html` must not hold. */
  function expectRedacted(plain: ShareReportData, html: string): void {
    const { data } = readSharePayload(html);
    const names = [
      // `~` names no one and occurs in the client code; the dictionary check covers it.
      ...plain.dictionaries.projects.filter((label) => label !== '(unattributed)' && label !== '~'),
      ...plain.dictionaries.machines.filter((label) => label !== 'local'),
    ];

    expect(names.length).toBeGreaterThan(0);
    expect(data.meta.redacted).toBe(true);
    expect(
      data.dictionaries.projects.every((label) => /^project-\d+$|^\(unattributed\)$/u.test(label)),
    ).toBe(true);
    expect(data.dictionaries.machines.every((label) => /^machine-\d+$|^local$/u.test(label))).toBe(
      true,
    );
    expectSelfContained(html);
    expectNoForbiddenStrings(html, forbidden);

    for (const name of names) {
      expect(html, 'a project or machine name').not.toContain(name);
    }
  }

  it('compare --by-repo --share --redact leaves out every project and machine name', async () => {
    const plain = readSharePayload(
      (await runShare('compare-plain', ['compare', '--by-repo'])).get('compare-share.html') ?? '',
    ).data;
    const files = await runShare('compare-redacted', ['compare', '--by-repo', '--redact']);

    expect([...files.keys()]).toEqual(['compare-share.html']);
    expect(plain.dictionaries.projects).toContain('~');
    expectRedacted(plain, files.get('compare-share.html') ?? '');
  });

  it('wrapped --share --redact leaves out another machine’s name and projects', async () => {
    const machine = 'laptop-secret';
    const remoteDir = path.join(environment.rootDir, 'remote');
    const remoteSession = path.join(remoteDir, 'claude', 'remote-project', 'session.jsonl');
    const configPath = path.join(environment.rootDir, 'machine-config.toml');
    const ssh = 'share-e2e.invalid';
    await mkdir(path.dirname(remoteSession), { recursive: true });
    await writeFile(
      remoteSession,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-19T09:30:00.000Z',
        sessionId: 'remote-secret-session',
        cwd: '/srv/remote-secret-repo',
        uuid: 'remote-secret-row',
        message: {
          id: 'remote-secret-msg',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 500, output_tokens: 50 },
        },
      }),
    );
    await writeFile(
      path.join(remoteDir, 'config.toml'),
      'sources = ["claude"]\n[sourceDirs]\nclaude = "claude"\n',
    );
    await writeFile(configPath, `[machines.${machine}]\nssh = "${ssh}"\n`);
    const remote = createInProcessRemote({
      configPath: path.join(remoteDir, 'config.toml'),
      eventStorePath: path.join(remoteDir, 'events.db'),
    });
    expect((await syncMachine(machine, { ssh }, { spawnSsh: remote.spawnSsh })).ok).toBe(true);
    vi.stubEnv('LLM_USAGE_CONFIG_PATH', configPath);
    // With source directories given, other machines are read only when --machine names them.
    const machineArgs = ['--machine', `local,${machine}`];

    try {
      const plain = readSharePayload(
        (await runShare('wrapped-plain', ['wrapped', ...machineArgs])).get(
          'llm-usage-wrapped-2026.html',
        ) ?? '',
      ).data;
      const files = await runShare('wrapped-redacted', ['wrapped', '--redact', ...machineArgs]);
      const html = files.get('llm-usage-wrapped-2026.html') ?? '';

      expect(plain.dictionaries.machines).toEqual(expect.arrayContaining(['local', machine]));
      expect(plain.dictionaries.projects).toContain('remote-secret-repo');
      expect(plain.envelope?.report).toBe('wrapped');
      expect([...files.keys()]).toEqual(['llm-usage-wrapped-2026.html']);
      expectRedacted(plain, html);
      expect(readSharePayload(html).data.envelope?.report).toBe('wrapped');
      expect(html).not.toContain('remote-secret-session');
      expect(html).not.toContain('/srv/');
    } finally {
      vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(environment.rootDir, 'missing-config.toml'));
      await deleteMachineCache(machine);
    }
  });
});
