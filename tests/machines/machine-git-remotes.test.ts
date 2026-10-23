import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProjectsData } from '../../src/cli/build-projects-data.js';
import { runMachineAdd, runSync } from '../../src/cli/run-machine-commands.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

let rootDir: string;

/** A git repository at `directory` whose `origin` is `url`. */
async function createRepository(directory: string, url: string): Promise<void> {
  await mkdir(path.join(directory, '.git'), { recursive: true });
  await writeFile(
    path.join(directory, '.git', 'config'),
    `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/app\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}

/** A codex session in `cwd` with one request, in `directory`. */
async function writeCodexSession(directory: string, id: string, cwd: string): Promise<void> {
  const usage = {
    input_tokens: 200,
    cached_input_tokens: 50,
    output_tokens: 100,
    reasoning_output_tokens: 20,
    total_tokens: 370,
  };
  const lines = [
    { timestamp: '2026-06-01T08:00:00.000Z', type: 'session_meta', payload: { id, cwd } },
    {
      timestamp: '2026-06-01T08:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.2-codex' },
    },
    {
      timestamp: '2026-06-01T08:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } },
    },
  ];
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${id}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'machine-git-remotes-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(rootDir, 'data'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(rootDir, { recursive: true, force: true });
});

/**
 * Syncs a laptop whose sessions ran in `laptopCwds`, after this machine's ran in
 * `localCwds`, and returns the projects report's rows as [repoRoot, events], sorted.
 */
async function projectsAfterSync(
  laptopCwds: readonly string[],
  localCwds: readonly string[],
): Promise<(string | number | null)[][]> {
  const writeSessions = async (machine: string, cwds: readonly string[]) => {
    for (const [index, cwd] of cwds.entries()) {
      await writeCodexSession(
        path.join(rootDir, machine, 'codex'),
        `${machine}-${String(index)}`,
        cwd,
      );
    }

    const configPath = path.join(rootDir, machine, 'config.toml');
    await writeFile(configPath, `sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n`);
    return configPath;
  };
  const laptopConfig = await writeSessions('laptop', laptopCwds);
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', await writeSessions('desktop', localCwds));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'desktop', 'events.db'));

  const { spawnSsh } = createInProcessRemote({
    configPath: laptopConfig,
    eventStorePath: path.join(rootDir, 'laptop', 'events.db'),
  });
  await runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print: () => undefined });
  await runSync([], {}, { spawnSsh, print: () => undefined, now: () => NOW });

  const data = await buildProjectsData({ timezone: 'UTC', pricingOffline: true });
  return data.projects
    .map((project) => [project.repoRoot, project.events])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
}

describe('another machine’s repository with the same remote', () => {
  const laptopRepo = () => path.join(rootDir, 'laptop', 'Projects', 'Personal', 'App');
  const localRepo = () => path.join(rootDir, 'desktop', 'projects', 'app');

  beforeEach(async () => {
    // The laptop cloned over ssh into Projects/Personal; this machine over https into projects.
    await createRepository(laptopRepo(), 'git@github.com:Me/App.git');
    await createRepository(localRepo(), 'https://github.com/me/app');
  });

  it('counts under the repository here, wherever each machine cloned it', async () => {
    const laptopOther = path.join(rootDir, 'laptop', 'Projects', 'tool');
    await createRepository(laptopOther, 'git@github.com:me/tool.git');

    // The laptop's `App/site` keeps its folder below the repository; `tool` has no clone here.
    expect(
      await projectsAfterSync([path.join(laptopRepo(), 'site'), laptopOther], [localRepo()]),
    ).toEqual([
      [localRepo(), 1],
      [path.join(localRepo(), 'site'), 1],
      [laptopOther, 1],
    ]);
  });

  it('finds the repository here when only its worktrees have usage', async () => {
    const worktree = path.join(rootDir, 'desktop', 'wt', 'app-feature');
    await mkdir(path.join(localRepo(), '.git', 'worktrees', 'app-feature'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(localRepo(), '.git', 'worktrees', 'app-feature')}\n`,
    );

    expect(await projectsAfterSync([laptopRepo()], [worktree])).toEqual([[localRepo(), 2]]);
  });

  it('moves nothing when two repositories here share the remote', async () => {
    const otherClone = path.join(rootDir, 'desktop', 'checkouts', 'app');
    await createRepository(otherClone, 'git@github.com:me/app.git');

    expect(await projectsAfterSync([laptopRepo()], [localRepo(), otherClone])).toEqual([
      [otherClone, 1],
      [localRepo(), 1],
      [laptopRepo(), 1],
    ]);
  });
});
