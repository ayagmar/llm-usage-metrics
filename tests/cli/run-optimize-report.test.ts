import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shareArtifact from '../../src/cli/share-artifact.js';

vi.mock('../../src/cli/build-optimize-data.js', () => ({
  buildOptimizeData: vi.fn(async () => ({
    rows: [
      {
        rowType: 'baseline',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        baselineCostUsd: 2,
        baselineCostIncomplete: false,
      },
      {
        rowType: 'candidate',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-5-codex',
        candidateResolvedModel: 'gpt-5-codex',
        hypotheticalCostUsd: 1.5,
        hypotheticalCostIncomplete: false,
        savingsUsd: 0.5,
        savingsRatio: 0.25,
      },
      {
        rowType: 'candidate',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'missing-model',
        candidateResolvedModel: 'missing-model',
        hypotheticalCostUsd: undefined,
        hypotheticalCostIncomplete: true,
        savingsUsd: undefined,
        savingsRatio: undefined,
        notes: ['missing_pricing'],
      },
    ],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
      provider: 'openai',
      baselineCostIncomplete: false,
      candidatesWithMissingPricing: ['missing-model'],
    },
  })),
}));

vi.mock('../../src/cli/build-share-report-data.js', () => ({
  buildShareReport: vi.fn(),
}));

import { buildOptimizeData } from '../../src/cli/build-optimize-data.js';
import { buildShareReport } from '../../src/cli/build-share-report-data.js';
import { buildOptimizeReport, runOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { readSharePayload } from '../helpers/share-html.js';
import { readFixturePayload } from '../share-report/client/core/share-fixture.js';

describe('run-optimize-report', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  it('rejects mutually exclusive output flags', async () => {
    await expect(
      buildOptimizeReport('daily', {
        markdown: true,
        json: true,
        candidateModel: ['gpt-4.1'],
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');
  });

  it('renders terminal output with optimize title', async () => {
    const report = await buildOptimizeReport('monthly', {
      candidateModel: ['gpt-4.1'],
    });

    expect(report).toContain('Monthly Optimize Report');
    expect(report).toContain('│ Period');
    expect(report).toContain('│ Candidate');
  });

  it('renders deterministic JSON row ordering', async () => {
    const report = await buildOptimizeReport('daily', {
      candidateModel: ['gpt-4.1'],
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: Array<{ rowType: string; candidateModel?: string }>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'optimize' });
    expect(parsed.data.map((row) => row.rowType)).toEqual(['baseline', 'candidate', 'candidate']);
    expect(parsed.data[1]?.candidateModel).toBe('gpt-5-codex');
    expect(parsed.data[2]?.candidateModel).toBe('missing-model');
  });

  it('renders markdown output when --markdown is set', async () => {
    const report = await buildOptimizeReport('daily', {
      candidateModel: ['gpt-4.1'],
      markdown: true,
    });

    expect(report).toContain('| Candidate');
    expect(report).toContain('| BASELINE');
  });

  it('keeps diagnostics on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOptimizeReport('daily', {
      candidateModel: ['gpt-4.1'],
      json: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(stdoutBody) as {
      schemaVersion: number;
      report: string;
      data: unknown;
    };
    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'optimize' });
    expect(Array.isArray(parsed.data)).toBe(true);

    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('No session files found'))).toBe(true);
    // stdout names the provider scope; stderr does not repeat it.
    expect(stderrLines.some((line) => line.includes('provider scope'))).toBe(false);
    expect(
      stderrLines.some((line) => line.includes('Missing pricing for candidate model(s)')),
    ).toBe(true);
  });

  it('emits runtime profile diagnostics on stderr when enabled', async () => {
    const previousProfile = process.env.LLM_USAGE_PROFILE_RUNTIME;
    process.env.LLM_USAGE_PROFILE_RUNTIME = '1';
    vi.mocked(buildOptimizeData).mockResolvedValueOnce({
      rows: [],
      diagnostics: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
        runtimeProfile: {
          sourceSelection: {
            availableSourceIds: ['pi', 'codex'],
            selectedSourceIds: ['codex'],
            candidateProviderRoots: ['openai'],
          },
          eventStore: {
            hits: 0,
            misses: 0,
          },
          parseTotals: {
            filesFound: 1,
            eventsParsed: 2,
          },
          sourceStats: [
            {
              source: 'codex',
              filesFound: 1,
              eventsParsed: 2,
              eventStoreHits: 0,
              eventStoreMisses: 0,
            },
          ],
          stageTimings: [{ name: 'optimize.dataset.total', durationMs: 1.23 }],
        },
        provider: 'openai',
        baselineCostIncomplete: false,
        candidatesWithMissingPricing: [],
      },
    });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runOptimizeReport('daily', {
        candidateModel: ['gpt-4.1'],
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
      expect(stderrLines.some((line) => line.includes('Runtime profile:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('source selection:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('stage timings:'))).toBe(true);
    } finally {
      if (previousProfile === undefined) {
        delete process.env.LLM_USAGE_PROFILE_RUNTIME;
      } else {
        process.env.LLM_USAGE_PROFILE_RUNTIME = previousProfile;
      }
    }
  });

  it('emits optimize warning diagnostics when provided by data builder', async () => {
    const buildOptimizeDataMock = vi.mocked(buildOptimizeData);
    buildOptimizeDataMock.mockResolvedValueOnce({
      rows: [],
      diagnostics: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
        provider: 'openai',
        baselineCostIncomplete: false,
        candidatesWithMissingPricing: [],
        warning: 'token mismatch warning',
      },
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runOptimizeReport('daily', {
      candidateModel: ['gpt-4.1'],
      json: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('token mismatch warning'))).toBe(true);
  });

  it('lists rows instead of an overflowing table on a narrow terminal', async () => {
    const stdout = process.stdout as NodeJS.WriteStream;
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(stdout, 'isTTY');
    const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, 'columns');

    Object.defineProperty(stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(stdout, 'columns', { configurable: true, value: 30 });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runOptimizeReport('daily', {
        candidateModel: ['gpt-4.1'],
      });
    } finally {
      if (isTTYDescriptor) {
        Object.defineProperty(stdout, 'isTTY', isTTYDescriptor);
      } else {
        Reflect.deleteProperty(stdout, 'isTTY');
      }

      if (columnsDescriptor) {
        Object.defineProperty(stdout, 'columns', columnsDescriptor);
      } else {
        Reflect.deleteProperty(stdout, 'columns');
      }
    }

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0][0])).not.toContain('╭');
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('Report table is wider than terminal'))).toBe(
      false,
    );
  });

  it('writes the optimize share report for any granularity, embedding the --json rows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'optimize-share-'));
    tempDirs.push(tempDir);
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    vi.mocked(buildShareReport).mockResolvedValue({ data: readFixturePayload().data });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runOptimizeReport('weekly', {
        candidateModel: ['gpt-4.1'],
        since: '2026-02-01',
        share: true,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const [request] = vi.mocked(buildShareReport).mock.calls[0] ?? [];
    const json = JSON.parse(
      await buildOptimizeReport('weekly', { candidateModel: ['gpt-4.1'], json: true }),
    ) as { data: unknown };

    expect(request).toMatchObject({
      command: 'optimize',
      window: { since: '2026-02-01', until: null },
      initialView: { since: '2026-02-01', until: null, granularity: 'week' },
      envelope: { report: 'optimize', data: json.data },
    });
    expect(await readdir(tempDir)).toEqual(['optimize-weekly-share.html']);
    const html = await readFile(path.join(tempDir, 'optimize-weekly-share.html'), 'utf8');
    expect(readSharePayload(html).data).toEqual(readFixturePayload().data);
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));

    expect(stderrLines.some((line) => line.includes('Wrote optimize share report'))).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });
});
