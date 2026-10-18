import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { buildSummaryReport } from '../../src/cli/run-summary-report.js';
import { createGitFixtureRepo, isolatedGitEnv } from '../helpers/git-fixtures.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  expectGolden,
  freezeDate,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M10_E2_GOLDEN_NAMES } from './m10-e2-names.js';
import { M14_CL_GOLDEN_NAMES } from './m14-cl-names.js';

const [efficiencyEmpty, optimizeEmpty, summaryEmpty] = M10_E2_GOLDEN_NAMES;
const [efficiencyMarkdownEmpty] = M14_CL_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

/** A month before every fixture event. */
const emptyWindow = { since: '2025-01-01', until: '2025-01-31' } as const;

describe.skipIf(process.platform === 'win32')(
  `empty-window goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useBundledPricingOnly();
    useGoldenUpdateCheck([...M10_E2_GOLDEN_NAMES, ...M14_CL_GOLDEN_NAMES]);
    let sources: SourceOptions & { source: string; timezone: 'UTC' };
    let repoDir: string;

    beforeAll(async () => {
      freezeDate();
      sources = {
        ...(await createE2eSourceOptions(environment.rootDir)),
        source: ALL_SOURCE_IDS.join(','),
        timezone: 'UTC',
      };

      // Commits in the window, but no usage, so efficiency has no period to show.
      const gitRepo = await createGitFixtureRepo(path.join(environment.rootDir, 'git'), [
        { date: '2025-01-10T10:00:00Z', message: 'in the window', files: { 'a.txt': 'one\n' } },
      ]);
      repoDir = gitRepo.repoDir;

      for (const [name, value] of Object.entries(isolatedGitEnv(gitRepo.globalConfigPath))) {
        vi.stubEnv(name, value);
      }
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    /** Gemini and Kimi report a non-OpenAI provider, which conflicts with --provider openai. */
    function openAiScopedSources() {
      const scoped = { ...sources, source: 'codex' };
      delete scoped.geminiDir;
      delete scoped.kimiDir;
      return scoped;
    }

    async function renderTerminal(render: () => Promise<string>): Promise<string> {
      const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);

      try {
        const output = await render();
        expect(output).not.toContain('\u001B[');
        return normalizePaths(output, environment.rootDir);
      } finally {
        restoreStdout();
      }
    }

    it(`freezes ${efficiencyEmpty}`, async () => {
      const output = await renderTerminal(() =>
        buildEfficiencyReport('monthly', {
          ...sources,
          pricingOffline: true,
          ...emptyWindow,
          repoDir,
        }),
      );

      await expectGolden(efficiencyEmpty, output);
    });

    // Markdown matches the terminal: the no-usage line, not an all-zero table.
    it(`freezes ${efficiencyMarkdownEmpty}`, async () => {
      const output = await buildEfficiencyReport('monthly', {
        ...sources,
        pricingOffline: true,
        ...emptyWindow,
        repoDir,
        markdown: true,
      });

      await expectGolden(efficiencyMarkdownEmpty, normalizePaths(output, environment.rootDir));
    });

    it(`freezes ${optimizeEmpty}`, async () => {
      const output = await renderTerminal(() =>
        buildOptimizeReport('monthly', {
          ...openAiScopedSources(),
          pricingOffline: true,
          ...emptyWindow,
          provider: 'openai',
          candidateModel: ['gpt-4.1'],
        }),
      );

      await expectGolden(optimizeEmpty, output);
    });

    it(`freezes ${summaryEmpty}`, async () => {
      // A year after the fixtures, with no filter: files are found but hold no recent usage.
      const output = await renderTerminal(() =>
        buildSummaryReport(
          { ...sources, source: undefined, pricingOffline: true },
          { now: () => new Date('2028-06-21T12:00:00.000Z') },
        ),
      );

      await expectGolden(summaryEmpty, output);
    });
  },
);
