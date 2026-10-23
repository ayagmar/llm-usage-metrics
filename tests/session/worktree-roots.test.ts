import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { moveRepoFilterPaths, normalizeRepoFilter } from '../../src/cli/repo-filter.js';
import {
  moveEventsToRepositories,
  resolveWorktreeRoots,
} from '../../src/session/worktree-roots.js';
import { isolatedGitEnv } from '../helpers/git-fixtures.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(canonicalTmpdir(), 'worktree-roots-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A directory with a `.git` directory, as `git init` leaves it. */
async function makeRepository(relativePath: string): Promise<string> {
  const repo = path.join(root, relativePath);
  await mkdir(path.join(repo, '.git', 'worktrees'), { recursive: true });
  return repo;
}

/** A directory whose `.git` file points at `gitdir`, as a linked worktree or submodule has. */
async function makeGitFile(relativePath: string, gitdir: string): Promise<string> {
  const directory = path.join(root, relativePath);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '.git'), `gitdir: ${gitdir}\n`);
  return directory;
}

const missing = (relativePath: string) => path.join(root, relativePath);

describe('resolveWorktreeRoots', () => {
  it('moves a worktree git created, and the directories under it, to its repository', async () => {
    const repo = path.join(root, 'git', 'app');
    const worktree = path.join(root, 'git', 'scratch', 'feature');
    const env = {
      ...process.env,
      ...isolatedGitEnv(path.join(root, 'empty-gitconfig')),
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(root, 'empty-gitconfig'), '');
    await execFileAsync('git', ['-C', repo, 'init', '-q'], { env });
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env,
    });
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-q', worktree], { env });

    // No session started at the worktree's root: its subfolder still finds the `.git` file.
    const subdirectory = path.join(worktree, 'packages', 'core');
    const roots = resolveWorktreeRoots([repo, subdirectory], new Map());

    expect(roots.repoKeyOf(subdirectory)).toBe(path.join(repo, 'packages', 'core'));
    expect(roots.repoKeyOf(worktree)).toBe(repo);
    expect(roots.repoKeyOf(repo)).toBeUndefined();
    expect(roots.newRoots).toEqual(
      new Map([
        [repo, repo],
        [worktree, repo],
      ]),
    );
  });

  it('moves a deleted worktree the store recorded, without recording it again', () => {
    const repo = missing('recorded/app');
    const worktree = missing('recorded/wt-1');
    const roots = resolveWorktreeRoots([worktree], new Map([[worktree, repo]]));

    expect(roots.repoKeyOf(worktree)).toBe(repo);
    expect(roots.repoKeyOf(path.join(worktree, 'src'))).toBe(path.join(repo, 'src'));
    expect(roots.newRoots.size).toBe(0);
  });

  it('keeps what the store first recorded for a path reused by another repository', async () => {
    const first = missing('reused/app');
    const second = await makeRepository('reused/api');
    const worktree = await makeGitFile('reused/wt', path.join(second, '.git', 'worktrees', 'wt'));
    const roots = resolveWorktreeRoots([worktree], new Map([[worktree, first]]));

    expect(roots.repoKeyOf(worktree)).toBe(first);
    expect(roots.newRoots.has(worktree)).toBe(false);
  });

  it('moves a deleted worktree recorded inside its repository folder', async () => {
    const repo = await makeRepository('nested/app');
    const worktree = path.join(repo, '.worktrees', 'feature');

    expect(
      resolveWorktreeRoots([repo, worktree], new Map([[worktree, repo]])).repoKeyOf(worktree),
    ).toBe(repo);
  });

  it('gives a name several repositories share to the one with worktrees', () => {
    const repo = missing('clones/projects/kipple');
    const reference = missing('clones/checkouts/kipple');
    const worktree = missing('clones/wt/feature');
    const key = missing('clones/cache/kipple-fix');
    const stored = new Map([
      [repo, repo],
      [reference, reference],
      [worktree, repo],
    ]);

    expect(resolveWorktreeRoots([key], stored).repoKeyOf(key)).toBe(repo);
  });

  it('matches names against repositories the store recorded, whatever the run read', () => {
    const repo = missing('stable/projects/kipple');
    const key = missing('stable/cache/kipple-fix');

    expect(resolveWorktreeRoots([key], new Map([[repo, repo]])).repoKeyOf(key)).toBe(repo);
  });

  it('keeps a submodule, whose .git file is no worktree, as its own project', async () => {
    const repo = await makeRepository('sub/app');
    const submodule = await makeGitFile(
      'sub/app/vendor/lib',
      path.join(repo, '.git', 'modules', 'lib'),
    );

    expect(resolveWorktreeRoots([repo, submodule], new Map()).repoKeyOf(submodule)).toBeUndefined();
  });

  it('counts a submodule inside a worktree as that folder of the repository', async () => {
    const repo = await makeRepository('wtsub/app');
    const worktree = await makeGitFile('wtsub/wt', path.join(repo, '.git', 'worktrees', 'wt'));
    const submodule = await makeGitFile(
      'wtsub/wt/vendor/lib',
      path.join(repo, '.git', 'worktrees', 'wt', 'modules', 'lib'),
    );
    const roots = resolveWorktreeRoots([worktree, submodule], new Map());

    expect([roots.repoKeyOf(worktree), roots.repoKeyOf(submodule)]).toEqual([
      repo,
      path.join(repo, 'vendor', 'lib'),
    ]);
  });

  it('moves a deleted directory named after a repository on disk, ignoring case', async () => {
    const repo = await makeRepository('names/projects/llm-usage-metrics');
    const keys = [
      repo,
      missing('names/cache/LLM-Usage-Metrics-orchestra/m9-integration'),
      missing('names/projects/review_llm-usage-metrics'),
    ];
    const roots = resolveWorktreeRoots(keys, new Map());

    expect(keys.map((key) => roots.repoKeyOf(key))).toEqual([undefined, repo, repo]);
  });

  it('prefers the longest repository name a directory matches', async () => {
    const shorter = await makeRepository('longest/kipple');
    const longer = await makeRepository('longest/kipple-core');
    const key = missing('longest/cache/kipple-core-wt');

    expect(resolveWorktreeRoots([shorter, longer, key], new Map()).repoKeyOf(key)).toBe(longer);
  });

  it('matches no name shared by two repositories, shorter than 4 characters, or whole', async () => {
    const first = await makeRepository('ambiguous/a/shared');
    const second = await makeRepository('ambiguous/b/shared');
    const short = await makeRepository('ambiguous/pi');
    const solo = await makeRepository('ambiguous/solo-repo');
    const keys = [
      missing('ambiguous/cache/shared-wt'),
      missing('ambiguous/pi-projects'),
      // A directory named exactly like a repository is another clone or another machine's.
      missing('ambiguous/elsewhere/solo-repo'),
    ];
    const roots = resolveWorktreeRoots([first, second, short, solo, ...keys], new Map());

    expect(keys.map((key) => roots.repoKeyOf(key))).toEqual([undefined, undefined, undefined]);
  });

  it('keeps a repository, and the directories inside it, even when named after another', async () => {
    const app = await makeRepository('own/app-name');
    const sibling = await makeRepository('own/app-name-cli');
    // Sessions only started in a package folder, never at the sibling's root.
    const inside = path.join(sibling, 'packages', 'app-name-web');
    const roots = resolveWorktreeRoots([app, inside], new Map());

    expect([roots.repoKeyOf(sibling), roots.repoKeyOf(inside)]).toEqual([undefined, undefined]);
  });

  it('reads no .git entry at or above the home directory', async () => {
    const home = await makeRepository('home/me');
    const key = path.join(home, 'notes');
    await mkdir(key);

    expect(resolveWorktreeRoots([key], new Map(), home).newRoots.size).toBe(0);
  });

  it('selects a worktree project with a --repo path inside the worktree', async () => {
    const repo = await makeRepository('filter/app');
    const worktree = await makeGitFile('filter/wt', path.join(repo, '.git', 'worktrees', 'wt'));
    const roots = resolveWorktreeRoots([worktree], new Map());
    const filter = moveRepoFilterPaths(
      normalizeRepoFilter(path.join(worktree, 'site')),
      roots.repoKeyOf,
    );

    expect(filter).toEqual([
      {
        kind: 'path',
        input: path.join(worktree, 'site'),
        path: path.join(repo, 'site').replaceAll('\\', '/'),
      },
    ]);
  });
});

describe('moveEventsToRepositories', () => {
  it('moves only local events whose project belongs to another and keeps the rest as they are', () => {
    const event = (repoRoot?: string, machine?: string) =>
      Object.assign(
        createUsageEvent({
          source: 'claude',
          sessionId: 's',
          timestamp: '2026-06-01T10:00:00.000Z',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          inputTokens: 1,
          outputTokens: 1,
          ...(repoRoot === undefined ? {} : { repoRoot }),
        }),
        // As other machines' usage is loaded.
        machine === undefined ? {} : { machine },
      );
    const kept = event('/w/app');
    const unattributed = event();
    const remote = event('/w/app-wt', 'laptop');
    const [moved] = moveEventsToRepositories(
      [[event('/w/app-wt/'), kept, unattributed, remote]],
      (key) => (key === '/w/app-wt' ? '/w/app' : undefined),
    );

    expect(moved.map((movedEvent) => movedEvent.repoRoot)).toEqual([
      '/w/app',
      '/w/app',
      undefined,
      '/w/app-wt',
    ]);
    expect(moved.slice(1)).toEqual([kept, unattributed, remote]);
  });
});
