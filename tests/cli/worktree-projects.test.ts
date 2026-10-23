import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { buildProjectsData } from '../../src/cli/build-projects-data.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';
import { freezeDate } from '../golden/golden-harness.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

function event(sessionId: string, repoRoot: string): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp: '2026-06-01T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    repoRoot,
  });
}

describe('projects run in git worktrees', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  let repo: string;
  let worktree: string;

  beforeAll(async () => {
    freezeDate();
    repo = path.join(environment.rootDir, 'projects', 'app');
    // Named after nothing, so only the worktree's .git file, or the store's record of it,
    // ties it to the repository.
    worktree = path.join(environment.rootDir, 'scratch', 'task-42');
    await mkdir(path.join(repo, '.git', 'worktrees', 'task-42'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'task-42')}\n`,
    );
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(environment.rootDir, 'events.db'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = () => ({
    createAdapters: (): SourceAdapter[] => [
      {
        id: 'claude',
        discoverFiles: async () => ['/tmp/s.jsonl'],
        read: readFrom(async () => [event('main', repo), event('feature', worktree)]),
      },
    ],
  });
  const options = { timezone: 'UTC', pricingOffline: true } as const;
  const projects = async (extra: Record<string, unknown> = {}) =>
    (await buildProjectsData({ ...options, ...extra }, deps())).projects.map((project) => [
      project.repoRoot,
      project.events,
    ]);

  it('counts a worktree under its repository, and still does once the worktree is deleted', async () => {
    expect(await projects()).toEqual([[repo, 2]]);

    await rm(worktree, { recursive: true });

    expect(await projects()).toEqual([[repo, 2]]);
  });

  it('selects the repository with --repo on the deleted worktree path', async () => {
    expect(await projects({ repo: worktree })).toEqual([[repo, 2]]);
  });
});
