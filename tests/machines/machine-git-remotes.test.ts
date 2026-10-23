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

describe('another machine’s repository with the same remote', () => {
  it('counts under the repository here, wherever each machine cloned it', async () => {
    // The laptop cloned over ssh into Projects/Personal; this machine over https into projects.
    const laptopRepo = path.join(rootDir, 'laptop', 'Projects', 'Personal', 'App');
    const laptopOther = path.join(rootDir, 'laptop', 'Projects', 'tool');
    const localRepo = path.join(rootDir, 'desktop', 'projects', 'app');
    await createRepository(laptopRepo, 'git@github.com:Me/App.git');
    await createRepository(laptopOther, 'git@github.com:me/tool.git');
    await createRepository(localRepo, 'https://github.com/me/app');

    const laptopSessions = path.join(rootDir, 'laptop', 'codex');
    await writeCodexSession(laptopSessions, 'laptop-app', path.join(laptopRepo, 'site'));
    await writeCodexSession(laptopSessions, 'laptop-tool', laptopOther);
    const laptopConfig = path.join(rootDir, 'laptop', 'config.toml');
    await writeFile(laptopConfig, `sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n`);

    const localSessions = path.join(rootDir, 'desktop', 'codex');
    await writeCodexSession(localSessions, 'desktop-app', localRepo);
    const localConfig = path.join(rootDir, 'desktop', 'config.toml');
    await writeFile(localConfig, `sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n`);
    vi.stubEnv('LLM_USAGE_CONFIG_PATH', localConfig);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'desktop', 'events.db'));

    const { spawnSsh } = createInProcessRemote({
      configPath: laptopConfig,
      eventStorePath: path.join(rootDir, 'laptop', 'events.db'),
    });
    await runMachineAdd('laptop', 'me@laptop', {}, { spawnSsh, print: () => undefined });
    await runSync([], {}, { spawnSsh, print: () => undefined, now: () => NOW });

    const data = await buildProjectsData({ timezone: 'UTC', pricingOffline: true });
    const projects = data.projects
      .map((project) => [project.repoRoot, project.events])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));

    // The laptop's `App/site` keeps its folder below the repository; `tool` has no clone here.
    expect(projects).toEqual([
      [localRepo, 1],
      [path.join(localRepo, 'site'), 1],
      [laptopOther, 1],
    ]);
  });
});
