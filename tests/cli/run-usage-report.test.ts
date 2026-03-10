import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shareArtifact from '../../src/cli/share-artifact.js';

import { buildUsageReport, runUsageReport } from '../../src/cli/run-usage-report.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

const tempDirs: string[] = [];
const originalParseMaxParallel = process.env.LLM_USAGE_PARSE_MAX_PARALLEL;
const directoryBackedSources = 'pi,codex';

function restoreParseMaxParallel(): void {
  if (originalParseMaxParallel === undefined) {
    delete process.env.LLM_USAGE_PARSE_MAX_PARALLEL;
    return;
  }

  process.env.LLM_USAGE_PARSE_MAX_PARALLEL = originalParseMaxParallel;
}

beforeEach(() => {
  restoreParseMaxParallel();
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

  restoreParseMaxParallel();
  vi.unstubAllGlobals();
});

describe('buildUsageReport', () => {
  it('aggregates droid sessions end-to-end when --source droid is provided', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be required for droid integration test');
    });

    vi.stubGlobal('fetch', fetchSpy);

    try {
      const report = await buildUsageReport('daily', {
        droidDir: path.resolve('tests/fixtures/droid/report'),
        source: 'droid',
        timezone: 'UTC',
        json: true,
        ignorePricingFailures: true,
      });

      const parsed = JSON.parse(report) as {
        rowType: string;
        periodKey: string;
        source: string;
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }[];

      const periodRow = parsed.find(
        (row) => row.rowType === 'period_source' && row.source === 'droid',
      );

      expect(periodRow).toMatchObject({
        rowType: 'period_source',
        periodKey: '2026-02-25',
        source: 'droid',
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        totalTokens: 18,
      });
      expect(parsed.at(-1)).toMatchObject({ rowType: 'grand_total', periodKey: 'ALL' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds markdown report with source-separated rows', async () => {
    const report = await buildUsageReport('daily', {
      piDir: path.resolve('tests/fixtures/pi'),
      codexDir: path.resolve('tests/fixtures/codex'),
      source: directoryBackedSources,
      timezone: 'UTC',
      markdown: true,
    });

    expect(report).toContain('| Period');
    expect(report).toContain('| Source');
    expect(report).toContain('| Models');
    expect(report).toMatch(/\|\s+\d{4}-\d{2}-\d{2}\s+\|\s+pi\s+\|/u);
    expect(report).toMatch(/\|\s+\d{4}-\d{2}-\d{2}\s+\|\s+codex\s+\|/u);
    expect(report).not.toMatch(/\|\s+\d{4}-\d{2}-\d{2}\s+\|\s+combined\s+\|/u);
    expect(report).toMatch(/\|\s+\*\*ALL\*\*\s+\|\s+\*\*TOTAL\*\*\s+\|/u);
    expect(report).not.toContain('Σ TOTAL');
  });

  it('builds markdown report with per-model column layout when requested', async () => {
    const report = await buildUsageReport('daily', {
      piDir: path.resolve('tests/fixtures/pi'),
      codexDir: path.resolve('tests/fixtures/codex'),
      source: directoryBackedSources,
      timezone: 'UTC',
      markdown: true,
      perModelColumns: true,
    });

    expect(report).toContain('Σ TOTAL');
    expect(report).toContain('<br>');
  });

  it('builds json report when --json semantics are requested', async () => {
    const report = await buildUsageReport('weekly', {
      piDir: path.resolve('tests/fixtures/pi'),
      codexDir: path.resolve('tests/fixtures/codex'),
      source: directoryBackedSources,
      timezone: 'UTC',
      json: true,
    });

    const parsed = JSON.parse(report) as { rowType: string; periodKey: string }[];

    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((row) => row.rowType === 'period_combined')).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ rowType: 'grand_total', periodKey: 'ALL' });
  });

  it('filters rows to a single source when --source is provided', async () => {
    const report = await buildUsageReport('daily', {
      piDir: path.resolve('tests/fixtures/pi'),
      codexDir: path.resolve('tests/fixtures/codex'),
      timezone: 'UTC',
      source: 'codex',
      json: true,
    });

    const parsed = JSON.parse(report) as { rowType: string; source: string }[];

    expect(parsed.some((row) => row.rowType === 'period_source' && row.source === 'codex')).toBe(
      true,
    );
    expect(parsed.some((row) => row.rowType === 'period_source' && row.source === 'pi')).toBe(
      false,
    );
    expect(parsed.some((row) => row.rowType === 'period_combined')).toBe(false);
  });

  it('supports comma-separated source filters', async () => {
    const report = await buildUsageReport('daily', {
      piDir: path.resolve('tests/fixtures/pi'),
      codexDir: path.resolve('tests/fixtures/codex'),
      timezone: 'UTC',
      source: 'pi,codex',
      json: true,
    });

    const parsed = JSON.parse(report) as { rowType: string; source: string }[];

    expect(parsed.some((row) => row.rowType === 'period_source' && row.source === 'pi')).toBe(true);
    expect(parsed.some((row) => row.rowType === 'period_source' && row.source === 'codex')).toBe(
      true,
    );
  });

  it('applies provider filtering when --provider is supplied', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-provider-filter-'));
    tempDirs.push(tempDir);

    const codexSessionPath = path.join(tempDir, 'session.jsonl');

    await writeFile(
      codexSessionPath,
      [
        JSON.stringify({
          timestamp: '2026-02-14T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-provider-test', model_provider: 'anthropic' },
        }),
        JSON.stringify({
          timestamp: '2026-02-14T10:00:01.000Z',
          type: 'turn_context',
          payload: { model: 'claude-3.7-sonnet' },
        }),
        JSON.stringify({
          timestamp: '2026-02-14T10:00:02.000Z',
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
        }),
      ].join('\n'),
      'utf8',
    );

    const report = await buildUsageReport('daily', {
      piDir: tempDir,
      codexDir: tempDir,
      source: directoryBackedSources,
      timezone: 'UTC',
      provider: 'openai',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      rowType: string;
      source: string;
      totalTokens: number;
      costUsd: number;
    }[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      rowType: 'grand_total',
      source: 'combined',
      totalTokens: 0,
      costUsd: 0,
    });
  });

  it('does not require pricing fetch when there are no events', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-no-events-'));
    tempDirs.push(emptyDir);

    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when there are no events');
    });

    vi.stubGlobal('fetch', fetchSpy);

    try {
      const report = await buildUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
        json: true,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(report)).toEqual([
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: [],
          modelBreakdown: [],
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders terminal output with report header only', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-terminal-output-'));
    tempDirs.push(emptyDir);

    process.env.LLM_USAGE_PARSE_MAX_PARALLEL = '8';

    const report = await buildUsageReport('monthly', {
      piDir: emptyDir,
      codexDir: emptyDir,
      source: directoryBackedSources,
      timezone: 'UTC',
    });

    expect(report).not.toContain('Active environment overrides:');
    expect(report).not.toContain('LLM_USAGE_PARSE_MAX_PARALLEL=8');
    expect(report).toContain('Monthly Token Usage Report');
    expect(report).not.toContain('Timezone');
    expect(report).toContain('│ Period');
    expect(report).toContain('│ ALL');
    expect(report.startsWith('\n')).toBe(false);

    const headerIndex = report.indexOf('┌');
    expect(headerIndex).toBeGreaterThan(-1);
  });

  it('does not prepend a blank line in terminal output when no overrides are active', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-terminal-no-overrides-'));
    tempDirs.push(emptyDir);

    const report = await buildUsageReport('daily', {
      piDir: emptyDir,
      codexDir: emptyDir,
      source: directoryBackedSources,
      timezone: 'UTC',
    });

    expect(report.startsWith('\n')).toBe(false);
    expect(report).toContain('Daily Token Usage Report');
    expect(report).not.toContain('Timezone');
  });

  it('validates date flags, range ordering and pricing URL', async () => {
    await expect(
      buildUsageReport('daily', {
        since: '2026-2-10',
      }),
    ).rejects.toThrow('--since must use format YYYY-MM-DD');

    await expect(
      buildUsageReport('daily', {
        until: '2026-02-30',
      }),
    ).rejects.toThrow('--until has an invalid calendar date');

    await expect(
      buildUsageReport('daily', {
        since: '2026-02-20',
        until: '2026-02-10',
      }),
    ).rejects.toThrow('--since must be less than or equal to --until');

    await expect(
      buildUsageReport('daily', {
        timezone: 'Invalid/Timezone',
      }),
    ).rejects.toThrow('Invalid timezone: Invalid/Timezone');

    await expect(
      buildUsageReport('daily', {
        pricingUrl: 'not-a-url',
      }),
    ).rejects.toThrow('--pricing-url must be a valid http(s) URL');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    );

    const piTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-pricing-url-fetch-fail-pi-'));
    const codexTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-pricing-url-fetch-fail-codex-'),
    );
    tempDirs.push(piTempDir, codexTempDir);

    const piSessionPath = path.join(piTempDir, 'session.jsonl');

    await writeFile(
      piSessionPath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-pricing-fail-session',
          timestamp: '2026-02-14T10:00:00.000Z',
        }),
        JSON.stringify({
          type: 'model_change',
          provider: 'openai',
          modelId: 'gpt-4.1',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-14T10:00:01.000Z',
          usage: {
            input: 10,
            output: 5,
            totalTokens: 15,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    await expect(
      buildUsageReport('daily', {
        piDir: piTempDir,
        codexDir: codexTempDir,
        source: 'pi',
        pricingUrl: 'https://example.test/pricing.json',
      }),
    ).rejects.toThrow('Could not load pricing from --pricing-url');
  });

  it('validates source and model filter input', async () => {
    await expect(
      buildUsageReport('daily', {
        source: '   ',
      }),
    ).rejects.toThrow('--source must contain at least one non-empty source id');

    await expect(
      buildUsageReport('daily', {
        source: 'claude',
      }),
    ).rejects.toThrow(
      'Unknown --source value(s): claude. Allowed values: codex, droid, gemini, opencode, pi',
    );

    await expect(
      buildUsageReport('daily', {
        model: '   ',
      }),
    ).rejects.toThrow('--model must contain at least one non-empty model filter');
  });

  it('validates conflicting output flags', async () => {
    await expect(
      buildUsageReport('daily', {
        markdown: true,
        json: true,
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');
  });

  it('keeps buildUsageReport side-effect free for terminal output', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-build-no-stderr-'));
    tempDirs.push(emptyDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const report = await buildUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(report).toContain('Daily Token Usage Report');
      expect(report).not.toContain('Timezone');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits diagnostics to stderr before writing terminal output in runUsageReport', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-diagnostics-'));
    tempDirs.push(emptyDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No sessions found'));
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(logSpy.mock.invocationCallOrder[0]);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('emits active environment overrides to stderr diagnostics in runUsageReport', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-env-overrides-'));
    tempDirs.push(emptyDir);
    process.env.LLM_USAGE_PARSE_MAX_PARALLEL = '8';

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('Active environment overrides:');
      const stderrLines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(stderrLines.some((line) => line.includes('Active environment overrides:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('LLM_USAGE_PARSE_MAX_PARALLEL=8'))).toBe(
        true,
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('emits runtime profile diagnostics to stderr when enabled', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-runtime-profile-'));
    tempDirs.push(emptyDir);
    const previousProfile = process.env.LLM_USAGE_PROFILE_RUNTIME;
    process.env.LLM_USAGE_PROFILE_RUNTIME = '1';

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const stderrLines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(stderrLines.some((line) => line.includes('Runtime profile:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('source selection:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('parse cache:'))).toBe(true);
      expect(stderrLines.some((line) => line.includes('stage timings:'))).toBe(true);
    } finally {
      if (previousProfile === undefined) {
        delete process.env.LLM_USAGE_PROFILE_RUNTIME;
      } else {
        process.env.LLM_USAGE_PROFILE_RUNTIME = previousProfile;
      }
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('emits a fullscreen hint only when terminal width cannot fit the table', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-overflow-hint-'));
    tempDirs.push(emptyDir);

    const restoreStdout = overrideStdoutTty(60);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('No sessions found')),
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('wider than terminal')),
      ).toBe(true);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      restoreStdout();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('does not emit a fullscreen hint when terminal column metadata is invalid', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-invalid-columns-'));
    tempDirs.push(emptyDir);

    const restoreStdout = overrideStdoutTty(0);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('wider than terminal')),
      ).toBe(false);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      restoreStdout();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('does not emit a fullscreen hint when table already fits terminal width', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-table-fits-'));
    tempDirs.push(emptyDir);

    const restoreStdout = overrideStdoutTty(300);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('wider than terminal')),
      ).toBe(false);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      restoreStdout();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('ignores non-table lines when deciding terminal overflow warning', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-non-table-overflow-'));
    tempDirs.push(emptyDir);

    const originalSessionKey = process.env.LLM_USAGE_UPDATE_CACHE_SESSION_KEY;
    process.env.LLM_USAGE_UPDATE_CACHE_SESSION_KEY = 'x'.repeat(400);
    const restoreStdout = overrideStdoutTty(130);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
      });

      expect(
        errorSpy.mock.calls.some((call) => String(call[0]).includes('wider than terminal')),
      ).toBe(false);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (originalSessionKey === undefined) {
        delete process.env.LLM_USAGE_UPDATE_CACHE_SESSION_KEY;
      } else {
        process.env.LLM_USAGE_UPDATE_CACHE_SESSION_KEY = originalSessionKey;
      }
      restoreStdout();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('keeps runUsageReport JSON output data-only on stdout while still emitting diagnostics', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-run-json-no-logs-'));
    tempDirs.push(emptyDir);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
        json: true,
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No sessions found'));
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('"rowType": "grand_total"');
      expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(logSpy.mock.invocationCallOrder[0]);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('writes usage share SVG when --share is enabled', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-share-sessions-'));
    const shareDir = await mkdtemp(path.join(os.tmpdir(), 'usage-share-output-'));
    tempDirs.push(emptyDir, shareDir);

    const previousCwd = process.cwd();
    process.chdir(shareDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let stderrLines: string[];
    let logCallCount: number;

    try {
      await runUsageReport('monthly', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
        share: true,
      });

      stderrLines = errorSpy.mock.calls.map((call) => String(call[0]));
      logCallCount = logSpy.mock.calls.length;
    } finally {
      process.chdir(previousCwd);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const svgPath = path.join(shareDir, 'usage-monthly-share.svg');
    const svgContent = await readFile(svgPath, 'utf8');

    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('TOKENS');
    expect(svgContent).toContain('llm-usage monthly --share');
    expect(stderrLines.some((line) => line.includes('Wrote usage share SVG'))).toBe(true);
    expect(logCallCount).toBe(1);
  });

  it('warns when usage share SVG cannot be opened after writing', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'usage-share-open-failure-sessions-'));
    tempDirs.push(emptyDir);

    vi.mocked(shareArtifact.writeAndOpenShareSvgFile).mockResolvedValueOnce({
      outputPath: '/tmp/usage-monthly-share.svg',
      opened: false,
      openErrorMessage: 'open failed',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let stderrLines!: string[];

    try {
      await runUsageReport('monthly', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: directoryBackedSources,
        timezone: 'UTC',
        share: true,
      });
      stderrLines = errorSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(stderrLines.some((line) => line.includes('Wrote usage share SVG'))).toBe(true);
    expect(stderrLines.some((line) => line.includes('Could not open usage share SVG'))).toBe(true);
  });
});
