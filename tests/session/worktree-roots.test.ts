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

    const subdirectory = path.join(worktree, 'packages', 'core');
    const roots = resolveWorktreeRoots([repo, worktree, subdirectory], new Map());

    expect(roots.repoKeyOf(worktree)).toBe(repo);
    expect(roots.repoKeyOf(subdirectory)).toBe(path.join(repo, 'packages', 'core'));
    expect(roots.repoKeyOf(repo)).toBeUndefined();
    expect(roots.newWorktrees).toEqual(new Map([[worktree, repo]]));
  });

  it('moves a deleted worktree the store recorded, without recording it again', () => {
    const repo = missing('recorded/app');
    const worktree = missing('recorded/wt-1');
    const roots = resolveWorktreeRoots([worktree], new Map([[worktree, repo]]));

    expect(roots.repoKeyOf(worktree)).toBe(repo);
    expect(roots.repoKeyOf(path.join(worktree, 'src'))).toBe(path.join(repo, 'src'));
    expect(roots.newWorktrees.size).toBe(0);
  });

  it('keeps a submodule, whose .git file is no worktree, as its own project', async () => {
    const repo = await makeRepository('sub/app');
    const submodule = await makeGitFile(
      'sub/app/vendor/lib',
      path.join(repo, '.git', 'modules', 'lib'),
    );

    expect(resolveWorktreeRoots([repo, submodule], new Map()).repoKeyOf(submodule)).toBeUndefined();
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
    const inside = path.join(sibling, 'tools', 'app-name-gen');
    const roots = resolveWorktreeRoots([app, sibling, inside], new Map());

    expect([roots.repoKeyOf(sibling), roots.repoKeyOf(inside)]).toEqual([undefined, undefined]);
  });

  it('selects a worktree project with a --repo path inside the worktree', async () => {
    const repo = await makeRepository('filter/app');
    const worktree = await makeGitFile('filter/wt', path.join(repo, '.git', 'worktrees', 'wt'));
    const roots = resolveWorktreeRoots([worktree], new Map());
    const filter = moveRepoFilterPaths(normalizeRepoFilter(worktree), roots.repoKeyOf);

    expect(filter).toEqual([{ kind: 'path', input: worktree, path: repo.replaceAll('\\', '/') }]);
  });
});

describe('moveEventsToRepositories', () => {
  it('moves only the events whose project belongs to another and keeps the rest as they are', () => {
    const event = (repoRoot?: string) =>
      createUsageEvent({
        source: 'claude',
        sessionId: 's',
        timestamp: '2026-06-01T10:00:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1,
        outputTokens: 1,
        ...(repoRoot === undefined ? {} : { repoRoot }),
      });
    const kept = event('/w/app');
    const unattributed = event();
    const [moved] = moveEventsToRepositories([[event('/w/app-wt/'), kept, unattributed]], (key) =>
      key === '/w/app-wt' ? '/w/app' : undefined,
    );

    expect(moved.map((movedEvent) => movedEvent.repoRoot)).toEqual(['/w/app', '/w/app', undefined]);
    expect(moved[1]).toBe(kept);
    expect(moved[2]).toBe(unattributed);
  });
});
