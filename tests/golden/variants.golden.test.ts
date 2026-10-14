import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildStatusline } from '../../src/cli/run-statusline.js';
import { createGitFixtureRepo, isolatedGitEnv } from '../helpers/git-fixtures.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  expectGolden,
  fixedNow,
  freezeDate,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

const claudeFixture = path.resolve('tests/fixtures/e2e/claude/e2e-project/session.jsonl');

/** Copies the Claude e2e session under `claudeDir` with every row's cwd set to `repoDir`. */
async function writeAttributedClaudeSession(claudeDir: string, repoDir: string): Promise<void> {
  const projectDir = path.join(claudeDir, 'e2e-project');
  const rows = (await readFile(claudeFixture, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.stringify({ ...(JSON.parse(line) as object), cwd: repoDir }));

  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'session.jsonl'), `${rows.join('\n')}\n`);
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `report variant goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    const pricing = useBundledPricingOnly();
    useGoldenUpdateCheck();
    let sources: SourceOptions & { source: string; timezone: 'UTC' };
    let repoDir: string;

    beforeAll(async () => {
      freezeDate();
      const gitRepo = await createGitFixtureRepo(path.join(environment.rootDir, 'git'), [
        {
          date: '2026-05-28T10:00:00Z',
          message: 'before the session',
          files: { 'notes.txt': 'one\ntwo\n' },
        },
        {
          date: '2026-06-19T10:00:00Z',
          message: 'day before',
          files: { 'notes.txt': 'one\ntwo\nthree\n', 'src/app.ts': 'export {};\n' },
        },
        {
          date: '2026-06-20T12:30:00Z',
          message: 'after the session',
          files: { 'notes.txt': 'one\nthree\nfour\n' },
        },
      ]);
      repoDir = gitRepo.repoDir;

      for (const [name, value] of Object.entries(isolatedGitEnv(gitRepo.globalConfigPath))) {
        vi.stubEnv(name, value);
      }

      const claudeDir = path.join(environment.rootDir, 'claude-attributed');
      await writeAttributedClaudeSession(claudeDir, repoDir);
      sources = {
        ...(await createE2eSourceOptions(environment.rootDir)),
        claudeDir,
        source: ALL_SOURCE_IDS.join(','),
        timezone: 'UTC',
      };
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    function renderEfficiency(json: boolean): Promise<string> {
      return buildEfficiencyReport('monthly', {
        ...sources,
        pricingOffline: true,
        since: '2026-01-01',
        until: '2026-06-30',
        repoDir,
        json,
      });
    }

    it('freezes variants/efficiency-monthly-attributed.json', async () => {
      const output = await renderEfficiency(true);
      const rows = (JSON.parse(output) as { data: { rows: { commitCount?: number }[] } }).data.rows;

      // Commits are counted against the repo the Claude session ran in.
      expect(rows.some((row) => (row.commitCount ?? 0) > 0)).toBe(true);
      await expectGolden(
        'variants/efficiency-monthly-attributed.json',
        normalizePaths(output, environment.rootDir),
      );
    });

    it('freezes variants/efficiency-monthly-attributed.txt', async () => {
      const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
      let output: string;

      try {
        output = await renderEfficiency(false);
      } finally {
        restoreStdout();
      }

      expect(output).not.toContain('\u001B[');
      await expectGolden(
        'variants/efficiency-monthly-attributed.txt',
        normalizePaths(output, environment.rootDir),
      );
    });

    it('freezes variants/statusline-all-sources.txt', async () => {
      const output = `${await buildStatusline(sources, { now: fixedNow })}\n`;

      await expectGolden(
        'variants/statusline-all-sources.txt',
        normalizePaths(output, environment.rootDir),
      );
    });

    it('never reaches the network', () => {
      expect(pricing.fetch).not.toHaveBeenCalled();
    });
  },
);
