import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { runDoctorReport } from '../../src/cli/run-doctor-report.js';
import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { runPruneReport } from '../../src/cli/run-prune-report.js';
import { buildSessionReport } from '../../src/cli/run-session-report.js';
import { buildSummaryReport } from '../../src/cli/run-summary-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { buildWrappedReport } from '../../src/cli/run-wrapped-report.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { createGitFixtureRepo, isolatedGitEnv } from '../helpers/git-fixtures.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import {
  ALL_SOURCE_IDS,
  captureStdout,
  createE2eSourceOptions,
  expectGolden,
  fixedNow,
  FIXED_NOW,
  freezeDate,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

type Format = 'json' | 'markdown' | 'terminal';

const FORMAT_EXTENSIONS: Record<Format, string> = {
  json: 'json',
  markdown: 'md',
  terminal: 'txt',
};

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

const ALL_FORMATS: readonly Format[] = ['json', 'markdown', 'terminal'];
const JSON_ONLY: readonly Format[] = ['json'];
const NO_MARKDOWN: readonly Format[] = ['json', 'terminal'];

type FormatFlags = { json?: boolean; markdown?: boolean };

type ReportCase = {
  /** `<command>[-<granularity>][-<variant>]` */
  name: string;
  formats: readonly Format[];
  /** Returns the report's stdout. */
  render: (flags: FormatFlags) => Promise<string>;
  /** Checks the parsed JSON output before it is compared. */
  checkJson?: (json: string) => void;
};

function formatFlags(format: Format): FormatFlags {
  if (format === 'json') {
    return { json: true };
  }

  return format === 'markdown' ? { markdown: true } : {};
}

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

type EfficiencyTotals = {
  data: { rows: { rowType: string; commitCount: number; totalTokens: number }[] };
};

/** Fails unless the efficiency JSON counts both commits and tokens, so the golden is not all zeros. */
function expectAttributedEfficiency(json: string): void {
  const total = (JSON.parse(json) as EfficiencyTotals).data.rows.find(
    (row) => row.rowType === 'grand_total',
  );

  expect(total?.commitCount).toBeGreaterThan(0);
  expect(total?.totalTokens).toBeGreaterThan(0);
}

const noFilesAdapter: SourceAdapter = {
  id: 'codex',
  discoverFiles: async () => [],
  parseFile: async () => [],
};

async function seedStoreWithDepartedFile(dbPath: string, departedPath: string): Promise<void> {
  const store = await openEventStore(dbPath);

  try {
    replaceFileEvents(store, {
      source: 'codex',
      filePath: departedPath,
      fingerprint: {
        dependencies: [{ path: departedPath, exists: true, size: 10, mtimeMs: 20 }],
      },
      events: [
        createUsageEvent({
          source: 'codex',
          sessionId: 'golden-prune-session',
          timestamp: '2025-01-01T00:00:00.000Z',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      ],
      skippedRows: 0,
      now: 1_000,
    });
  } finally {
    closeEventStore(store);
  }
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`report goldens (${WINDOWS_SKIP_REASON})`, () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck();
  let sources: SourceOptions & { source: string; timezone: 'UTC' };
  let repoDir: string;
  /** The Claude e2e session with its cwd in `repoDir`, so efficiency counts the repo's commits. */
  let attributedClaudeDir: string;
  let pruneStorePath: string;

  beforeAll(async () => {
    freezeDate();
    sources = {
      ...(await createE2eSourceOptions(environment.rootDir)),
      source: ALL_SOURCE_IDS.join(','),
      timezone: 'UTC',
    };

    // The Claude session runs on 2026-06-20; only the last commit falls on that day.
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
    attributedClaudeDir = path.join(environment.rootDir, 'claude-attributed');
    await writeAttributedClaudeSession(attributedClaudeDir, repoDir);

    for (const [name, value] of Object.entries(isolatedGitEnv(gitRepo.globalConfigPath))) {
      vi.stubEnv(name, value);
    }

    const pruneDir = path.join(environment.rootDir, 'prune');
    await mkdir(pruneDir);
    pruneStorePath = path.join(pruneDir, 'events.db');
    // A fixed path rather than one under the temp root: the prune table sizes its path
    // column from the raw path, so a temp path's length would leak into the padding.
    await seedStoreWithDepartedFile(pruneStorePath, '/llm-usage-golden-missing/departed.jsonl');
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  /**
   * Gemini and Kimi report a fixed non-OpenAI provider, and naming them (by --source or a
   * dir option) conflicts with --provider openai, so optimize runs without them.
   */
  function openAiScopedSources() {
    const excluded = new Set(['gemini', 'kimi']);
    const scoped = {
      ...sources,
      source: ALL_SOURCE_IDS.filter((id) => !excluded.has(id)).join(','),
    };
    delete scoped.geminiDir;
    delete scoped.kimiDir;
    return scoped;
  }

  const firstHalf = { since: '2026-01-01', until: '2026-06-30' } as const;
  const priced = { pricingOffline: true } as const;

  const cases: ReportCase[] = [
    ...(['daily', 'weekly'] as const).map((granularity) => ({
      name: `usage-${granularity}`,
      formats: ALL_FORMATS,
      render: (flags: FormatFlags) =>
        buildUsageReport(granularity, { ...sources, ...priced, ...flags, all: true }),
    })),
    {
      name: 'usage-monthly',
      formats: ALL_FORMATS,
      render: (flags) =>
        buildUsageReport('monthly', { ...sources, ...priced, ...flags, ...firstHalf }),
    },
    {
      name: 'usage-daily-compact',
      formats: ['terminal'],
      render: () => buildUsageReport('daily', { ...sources, ...priced, all: true, compact: true }),
    },
    {
      name: 'usage-daily-per-model-columns',
      formats: ['terminal'],
      render: () =>
        buildUsageReport('daily', { ...sources, ...priced, all: true, perModelColumns: true }),
    },
    {
      name: 'usage-daily-no-cost',
      formats: ['terminal'],
      render: () => buildUsageReport('daily', { ...sources, ...priced, all: true, cost: false }),
    },
    {
      name: 'summary',
      formats: ALL_FORMATS,
      render: (flags) => buildSummaryReport({ ...sources, ...priced, ...flags }, { now: fixedNow }),
    },
    {
      name: 'compare',
      formats: ALL_FORMATS,
      render: (flags) =>
        buildCompareReport({
          ...sources,
          ...priced,
          ...flags,
          since: '2026-06-01',
          until: '2026-06-30',
          vsSince: '2026-05-01',
          vsUntil: '2026-05-31',
        }),
    },
    {
      name: 'trends-tokens',
      formats: ALL_FORMATS,
      render: (flags) =>
        buildTrendsReport({ ...sources, ...priced, ...flags, ...firstHalf, metric: 'tokens' }),
    },
    {
      name: 'trends-active-hours',
      formats: JSON_ONLY,
      render: (flags) =>
        buildTrendsReport({
          ...sources,
          ...priced,
          ...flags,
          ...firstHalf,
          metric: 'active-hours',
        }),
    },
    {
      name: 'trends-by-source',
      formats: JSON_ONLY,
      render: (flags) =>
        buildTrendsReport({
          ...sources,
          ...priced,
          ...flags,
          ...firstHalf,
          metric: 'tokens',
          bySource: true,
        }),
    },
    {
      name: 'session',
      formats: ALL_FORMATS,
      render: (flags) => buildSessionReport({ ...sources, ...priced, ...flags }),
    },
    {
      name: 'session-top-5',
      formats: JSON_ONLY,
      render: (flags) => buildSessionReport({ ...sources, ...priced, ...flags, top: '5' }),
    },
    {
      name: 'session-by-repo',
      formats: JSON_ONLY,
      render: (flags) => buildSessionReport({ ...sources, ...priced, ...flags, byRepo: true }),
    },
    ...(['daily', 'weekly', 'monthly'] as const).map((granularity) => ({
      name: `efficiency-${granularity}`,
      formats: granularity === 'monthly' ? ALL_FORMATS : JSON_ONLY,
      render: (flags: FormatFlags) =>
        buildEfficiencyReport(granularity, {
          ...sources,
          claudeDir: attributedClaudeDir,
          ...priced,
          ...flags,
          ...firstHalf,
          repoDir,
        }),
      checkJson: expectAttributedEfficiency,
    })),
    {
      name: 'optimize-monthly',
      formats: ALL_FORMATS,
      render: (flags) =>
        buildOptimizeReport('monthly', {
          ...openAiScopedSources(),
          ...priced,
          ...flags,
          provider: 'openai',
          candidateModel: ['gpt-4.1'],
          ignorePricingFailures: true,
        }),
    },
    {
      name: 'wrapped',
      formats: ALL_FORMATS,
      render: (flags) => buildWrappedReport({ ...sources, ...priced, ...flags, year: '2026' }),
    },
    {
      name: 'doctor',
      formats: NO_MARKDOWN,
      render: (flags) =>
        captureStdout(() =>
          runDoctorReport(
            { ...sources, json: flags.json },
            {
              getEventStoreRuntimeConfig: () => ({
                enabled: false as const,
                path: path.join(environment.rootDir, 'unused-store.db'),
                disabledBy: 'environment' as const,
              }),
              now: () => FIXED_NOW.getTime(),
            },
          ),
        ),
    },
    {
      name: 'prune',
      formats: NO_MARKDOWN,
      render: (flags) =>
        captureStdout(() =>
          runPruneReport(
            { suppressed: true, departedBefore: '2026-01-01', json: flags.json },
            {
              createAdapters: () => [noFilesAdapter],
              getEventStoreRuntimeConfig: () => ({ enabled: true, path: pruneStorePath }),
            },
          ),
        ),
    },
  ];

  for (const reportCase of cases) {
    for (const format of reportCase.formats) {
      const goldenName = `reports/${reportCase.name}.${FORMAT_EXTENSIONS[format]}`;

      it(`freezes ${goldenName}`, async () => {
        const restoreStdout =
          format === 'terminal' ? overrideStdoutTty(TERMINAL_COLUMNS) : undefined;
        let output: string;

        try {
          output = await reportCase.render(formatFlags(format));
        } finally {
          restoreStdout?.();
        }

        if (format === 'terminal') {
          expect(output).not.toContain('\u001B[');
        }

        if (format === 'json') {
          reportCase.checkJson?.(output);
        }

        await expectGolden(goldenName, normalizePaths(output, environment.rootDir));
      });
    }
  }

  it('never reaches the network', () => {
    expect(pricing.fetch).not.toHaveBeenCalled();
  });
});
