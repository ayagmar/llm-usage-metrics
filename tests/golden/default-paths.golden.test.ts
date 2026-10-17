import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalTmpdir } from '../helpers/tmp.js';
import { expectGolden, FIXED_GOLDENS, useGoldenUpdateCheck } from './golden-harness.js';

const execFileAsync = promisify(execFile);

function replaceRoot(text: string, rootDir: string): string {
  return text.replaceAll(rootDir, '<home>');
}

const LINUX_ONLY_REASON = 'default search paths differ per platform; the Linux leg freezes them';

// Linux only: default search paths differ per platform (macOS and Windows use other
// dirs for cline, roocode, kilocode, goose and opencode); the Linux leg freezes them.
// This also covers the Windows skip the other goldens make.
describe.skipIf(process.platform !== 'linux')(
  `default search path goldens (${LINUX_ONLY_REASON})`,
  () => {
    useGoldenUpdateCheck([FIXED_GOLDENS.defaultPathsDoctor]);
    let rootDir: string;

    beforeAll(async () => {
      rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'llm-usage-default-paths-'));
    });

    afterAll(async () => {
      await rm(rootDir, { recursive: true, force: true });
    });

    // A child process, so the home and data dirs adapters resolve at module load come
    // from this environment. Each variable gets its own dir under the root so the golden
    // shows which one a default path is built from. Only PATH is inherited: every source
    // and LLM_USAGE_* variable is unset.
    it('freezes default-paths/doctor.json', async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', 'doctor', '--json'],
        {
          env: {
            PATH: process.env.PATH,
            HOME: path.join(rootDir, 'home'),
            USERPROFILE: path.join(rootDir, 'userprofile'),
            APPDATA: path.join(rootDir, 'appdata'),
            LOCALAPPDATA: path.join(rootDir, 'localappdata'),
            XDG_CONFIG_HOME: path.join(rootDir, 'xdg-config'),
            XDG_DATA_HOME: path.join(rootDir, 'xdg-data'),
            XDG_CACHE_HOME: path.join(rootDir, 'xdg-cache'),
            XDG_STATE_HOME: path.join(rootDir, 'xdg-state'),
            LLM_USAGE_SKIP_UPDATE_CHECK: '1',
            LLM_USAGE_EVENT_STORE: '0',
            LLM_USAGE_CONFIG_PATH: path.join(rootDir, 'missing-config.toml'),
            TZ: 'UTC',
          },
        },
      );

      expect(stdout).not.toContain(process.cwd());
      await expectGolden(FIXED_GOLDENS.defaultPathsDoctor, replaceRoot(stdout, rootDir));
    });
  },
);
