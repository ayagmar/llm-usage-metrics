import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, vi } from 'vitest';

import { canonicalTmpdir } from './tmp.js';

/**
 * Variables `src/` reads that change which files are found or how they are parsed.
 * Keep in step with `rg -o 'env\.[A-Z_]+' src`. They are unset so a developer's shell
 * cannot leak into a run; the dirs and paths below point into the temp root instead.
 */
const UNSET_VARIABLES = [
  'COPILOT_OTEL_FILE_EXPORTER_PATH',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
  'DSH_HOME',
  'GOOSE_PATH_ROOT',
  'LLM_USAGE_PARSE_WORKERS',
  'LLM_USAGE_PARSE_WORKER_MIN_BYTES',
  'LLM_USAGE_EVENT_STORE_PATH',
  'LLM_USAGE_PROFILE_RUNTIME',
  'LLM_USAGE_UPDATE_CACHE_SCOPE',
  'LLM_USAGE_UPDATE_CACHE_SESSION_KEY',
  'FORCE_COLOR',
] as const;

export type IsolatedEnvironment = {
  /** A fresh canonical temp dir for this test file, removed after it. */
  readonly rootDir: string;
};

/**
 * Registers hooks that give the calling test file a fresh temp root and an environment
 * where only that root, never the user's home or shell, can feed a report: source env
 * vars unset, config, data and Windows profile dirs inside the root, the event store off,
 * colour off, `TZ=UTC`.
 *
 * Module-level defaults read `os.homedir()` at import time, before this runs, so tests
 * must pass every source's directory explicitly. Fixture file mtimes are left alone:
 * Claude and Copilot skip files whose mtime predates `--since`, and checkout mtimes are
 * later than every window the goldens use.
 */
export function useIsolatedEnvironment(): IsolatedEnvironment {
  let rootDir: string | undefined;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'llm-usage-isolated-'));
    const homeDir = path.join(rootDir, 'home');
    await mkdir(homeDir);

    for (const name of UNSET_VARIABLES) {
      vi.stubEnv(name, undefined);
    }

    // The efficiency report runs git with this environment; an inherited GIT_DIR,
    // GIT_WORK_TREE or GIT_AUTHOR_* would point it elsewhere or change its output.
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) {
      vi.stubEnv(name, undefined);
    }

    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('APPDATA', path.join(homeDir, 'AppData', 'Roaming'));
    vi.stubEnv('LOCALAPPDATA', path.join(homeDir, 'AppData', 'Local'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(homeDir, '.config'));
    vi.stubEnv('XDG_DATA_HOME', path.join(homeDir, '.local', 'share'));
    vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(rootDir, 'missing-config.toml'));
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
    vi.stubEnv('LLM_USAGE_SKIP_UPDATE_CHECK', '1');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('CI', '1');
    vi.stubEnv('TZ', 'UTC');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();

    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  return {
    get rootDir(): string {
      if (!rootDir) {
        throw new Error('useIsolatedEnvironment: the temp root exists only inside tests');
      }

      return rootDir;
    },
  };
}
