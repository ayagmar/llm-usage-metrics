import { readFile } from 'node:fs/promises';
import os from 'node:os';

import { asRecord } from '@ayagmar/agent-sessions/internal';
import { writeFileAtomic } from '../utils/fs-helpers.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import type { StatuslineSummary } from './run-statusline.js';
import type { StatuslineCommandOptions } from './usage-data-contracts.js';

/**
 * A line this recent is printed as it is. Building one reads every event of the past year,
 * which takes seconds on a large history, and each open session asks for a line on its own.
 */
export const STATUSLINE_REUSE_MS = 30_000;

/** Bump when the stored shape changes, so a line from an older version is rebuilt. */
const STORED_FORMAT = 1;

/** Outside the options and the config, these choose which logs a line covers. */
const SOURCE_ENV_VARS = [
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_OTEL_FILE_EXPORTER_PATH',
  'DSH_HOME',
  'GEMINI_CLI_HOME',
  'GOOSE_PATH_ROOT',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_DATA_HOME',
] as const;

/** Flags whose value can be a path relative to the working directory. */
const PATH_OPTION_PATTERN = /(?:Dir|Db|pricingOverrides)$/u;

export type StoredStatusline = {
  key: string;
  builtAt: number;
  today: string;
  timezone: string;
  summary: StatuslineSummary;
};

/**
 * A stored line is reused only by a tick asking for the same line. The working directory
 * counts only under a path flag: Claude Code runs the command from each session's project,
 * and those sessions must share a line. Config paths resolve against the config file.
 */
export function resolveStatuslineCacheKey(
  options: StatuslineCommandOptions,
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hasPathOption = Object.keys(options).some((name) => PATH_OPTION_PATTERN.test(name));

  return JSON.stringify([
    STORED_FORMAT,
    { ...options, verbose: undefined },
    config,
    SOURCE_ENV_VARS.map((name) => env[name]),
    os.homedir(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    hasPathOption ? process.cwd() : undefined,
  ]);
}

/** The stored line for this key, unless it was built for another day. */
export async function readStoredStatusline(
  cachePath: string,
  key: string,
  now: Date,
): Promise<StoredStatusline | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
    const record = asRecord(parsed);

    if (record?.key !== key || typeof record.timezone !== 'string') {
      return undefined;
    }

    // The key matched, so this version wrote the file with this shape.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const stored = record as StoredStatusline;

    return getCurrentLocalDateKey(stored.timezone, now) === stored.today ? stored : undefined;
  } catch {
    // Missing or torn: the tick builds a line, as it would with no file.
    return undefined;
  }
}

/** Failing to store a line only means the next tick builds its own. */
export async function writeStoredStatusline(
  cachePath: string,
  key: string,
  line: StatuslineSummary & { today: string; timezone: string },
  now: Date,
): Promise<void> {
  const stored: StoredStatusline = {
    key,
    builtAt: now.getTime(),
    today: line.today,
    timezone: line.timezone,
    summary: { periods: line.periods, monthEnd: line.monthEnd, activity: line.activity },
  };

  // Spend figures, so as private as the event store beside it.
  await writeFileAtomic(cachePath, JSON.stringify(stored), 0o600).catch(() => undefined);
}
