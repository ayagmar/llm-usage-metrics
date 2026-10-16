import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBlocksData } from '../../src/cli/build-blocks-data.js';
import type { BlocksCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { createInProcessRemote, type InProcessRemote } from '../helpers/machine-remote.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

let rootDir: string;
let remote: { configPath: string; eventStorePath: string };

/** A codex session on this machine, 90 minutes before the laptop's first event. */
const LOCAL_CODEX_SESSION = [
  {
    timestamp: '2026-01-05T06:30:00.000Z',
    type: 'session_meta',
    payload: { id: 'codex-local-session', model_provider: 'openai' },
  },
  {
    timestamp: '2026-01-05T06:30:01.000Z',
    type: 'turn_context',
    payload: { model: 'gpt-5.2-codex' },
  },
  {
    timestamp: '2026-01-05T06:30:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
          total_tokens: 15,
        },
      },
    },
  },
];

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'blocks-machine-'));
  const remoteDir = path.join(rootDir, 'remote');
  const localDir = path.join(rootDir, 'local');

  await cp(path.resolve('tests/fixtures/e2e/codex'), path.join(remoteDir, 'codex'), {
    recursive: true,
  });
  await writeFile(
    path.join(remoteDir, 'config.toml'),
    'sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n',
  );
  await mkdir(path.join(localDir, 'codex'), { recursive: true });
  await writeFile(
    path.join(localDir, 'codex', 'local.jsonl'),
    `${LOCAL_CODEX_SESSION.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
  await writeFile(
    path.join(localDir, 'config.toml'),
    'sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n[machines.laptop]\nssh = "me@laptop"\n',
  );

  vi.stubEnv('HOME', localDir);
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(localDir, 'config.toml'));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(localDir, 'events.db'));
  vi.stubEnv('XDG_DATA_HOME', path.join(localDir, 'data'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(localDir, 'cache'));
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is disabled in this test file');
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  remote = {
    configPath: path.join(remoteDir, 'config.toml'),
    eventStorePath: path.join(remoteDir, 'events.db'),
  };
  const outcome = await syncMachine(
    'laptop',
    { ssh: 'me@laptop' },
    { spawnSsh: createInProcessRemote(remote).spawnSsh },
  );
  expect(outcome.ok).toBe(true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

/** Eleven minutes on, so the laptop's cache is due for a refresh. */
const later = () => new Date(Date.now() + 11 * 60_000);

function exportCalls(ssh: InProcessRemote): number {
  return ssh.calls.filter((args) => args.at(-1)?.includes('machine export')).length;
}

async function blocks(options: BlocksCommandOptions, ssh = createInProcessRemote(remote)) {
  const result = await buildBlocksData(
    { timezone: 'UTC', all: true, pricingOffline: true, ...options },
    { spawnSsh: ssh.spawnSsh, now: later },
  );
  return result.data.blocks.map((block) => `${block.start} ${String(block.eventCount)}`);
}

describe('blocks with other machines', () => {
  it('chain every machine of a source as one account', async () => {
    expect(await blocks({})).toEqual(['2026-01-05T06:00:00.000Z 2', '2026-02-02T08:00:00.000Z 1']);
  });

  it('keep the account windows with --machine, counting only that machine', async () => {
    // This machine's 06:30 event starts the block the laptop's 08:00 event falls in.
    expect(await blocks({ machine: 'laptop' })).toEqual([
      '2026-01-05T06:00:00.000Z 1',
      '2026-02-02T08:00:00.000Z 1',
    ]);
    expect(await blocks({ machine: 'local' })).toEqual(['2026-01-05T06:00:00.000Z 1']);
  });

  it('never refresh a machine --machine leaves out', async () => {
    const ssh = createInProcessRemote(remote);

    await blocks({ machine: 'local' }, ssh);

    expect(exportCalls(ssh)).toBe(0);
  });
});
