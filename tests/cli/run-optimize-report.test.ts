import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        savingsPct: 0.25,
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
        savingsPct: undefined,
        notes: ['missing_pricing'],
      },
    ],
    diagnostics: {
      usage: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
      },
      provider: 'openai',
      baselineCostIncomplete: false,
      candidatesWithMissingPricing: ['missing-model'],
    },
  })),
}));

import { buildOptimizeData } from '../../src/cli/build-optimize-data.js';
import { buildOptimizeReport, runOptimizeReport } from '../../src/cli/run-optimize-report.js';

describe('run-optimize-report', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.spyOn(shareArtifact, 'writeAndOpenShareSvgFile').mockImplementation(
      async (fileName, svgContent) => ({
        outputPath: await shareArtifact.writeShareSvgFile(fileName, svgContent),
        opened: true,
      }),
    );
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

    const parsed = JSON.parse(report) as Array<{ rowType: string; candidateModel?: string }>;

    expect(parsed.map((row) => row.rowType)).toEqual(['baseline', 'candidate', 'candidate']);
    expect(parsed[1]?.candidateModel).toBe('gpt-5-codex');
    expect(parsed[2]?.candidateModel).toBe('missing-model');
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
    const parsed = JSON.parse(stdoutBody) as unknown;
    expect(Array.isArray(parsed)).toBe(true);

    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('No sessions found'))).toBe(true);
    expect(stderrLines.some((line) => line.includes('Optimize provider scope'))).toBe(true);
    expect(
      stderrLines.some((line) => line.includes('Missing pricing for candidate model(s)')),
    ).toBe(true);
  });

  it('emits optimize warning diagnostics when provided by data builder', async () => {
    const buildOptimizeDataMock = vi.mocked(buildOptimizeData);
    buildOptimizeDataMock.mockResolvedValueOnce({
      rows: [],
      diagnostics: {
        usage: {
          sessionStats: [],
          sourceFailures: [],
          skippedRows: [],
          pricingOrigin: 'none',
          activeEnvOverrides: [],
          timezone: 'UTC',
        },
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

  it('warns when terminal output overflows tty width', async () => {
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
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('Report table is wider than terminal'))).toBe(
      true,
    );
  });

  it('writes monthly optimize share svg when --share is enabled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'optimize-share-'));
    tempDirs.push(tempDir);
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runOptimizeReport('monthly', {
        candidateModel: ['gpt-4.1'],
        share: true,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const svgPath = path.join(tempDir, 'optimize-monthly-share.svg');
    const svgContent = await readFile(svgPath, 'utf8');
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));

    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('Monthly Optimize');
    expect(stderrLines.some((line) => line.includes('Wrote optimize share SVG'))).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects --share for non-monthly optimize reports', async () => {
    await expect(
      buildOptimizeReport('weekly', {
        candidateModel: ['gpt-4.1'],
        share: true,
      }),
    ).rejects.toThrow('--share is only supported for optimize monthly');
  });
});
