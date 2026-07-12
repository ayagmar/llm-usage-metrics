import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/build-session-data.js', () => ({
  buildSessionData: vi.fn(async () => ({
    grouping: 'session',
    rows: [
      {
        rowType: 'session',
        source: 'pi',
        sessionId: 'session-abcdef123456',
        repoRoot: '/home/user/project-alpha',
        firstActivity: '2026-03-05T10:00:00.000Z',
        lastActivity: '2026-03-05T10:00:00.000Z',
        eventCount: 1,
        models: ['gpt-4.1'],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.01,
      },
    ],
    limitNote: 'Showing top 1 of 2 sessions by cost. Use --top 0 for all.',
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
    },
  })),
}));

import { buildSessionData } from '../../src/cli/build-session-data.js';
import { buildSessionReport, runSessionReport } from '../../src/cli/run-session-report.js';

describe('run-session-report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds JSON output without diagnostics in the body', async () => {
    const report = await buildSessionReport({
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: Array<{ sessionId: string; diagnostics?: unknown }>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'session' });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.sessionId).toBe('session-abcdef123456');
    expect(parsed.data[0]).not.toHaveProperty('diagnostics');
  });

  it('renders markdown output when requested', async () => {
    const report = await buildSessionReport({
      markdown: true,
    });

    expect(report).toContain('| Session');
    expect(report).toContain('…abcdef123456');
  });

  it('renders untruncated session ids when an id filter is set', async () => {
    const report = await buildSessionReport({
      markdown: true,
      id: ['abcdef'],
    });

    expect(report).toContain('session-abcdef123456');
    expect(report).not.toContain('…abcdef123456');
  });

  it('rejects mutually exclusive output flags before building data', async () => {
    const buildCallsBefore = vi.mocked(buildSessionData).mock.calls.length;

    await expect(
      buildSessionReport({
        markdown: true,
        json: true,
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');

    expect(vi.mocked(buildSessionData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('keeps diagnostics and the limit note on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runSessionReport({
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(stdoutBody) as {
        schemaVersion: number;
        report: string;
        data: unknown;
      };
      expect(parsed).toMatchObject({ schemaVersion: 1, report: 'session' });
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(stdoutBody).not.toContain('Showing top');

      const stderrBody = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderrBody).toContain('Showing top 1 of 2 sessions by cost. Use --top 0 for all.');
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('emits no limit note when the result is not limited', async () => {
    vi.mocked(buildSessionData).mockResolvedValueOnce({
      grouping: 'session',
      rows: [],
      diagnostics: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
      },
    });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runSessionReport({ json: true });

      const stderrBody = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderrBody).not.toContain('Showing top');
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('delegates to buildSessionData', async () => {
    await buildSessionReport({ top: '5', json: true });

    expect(vi.mocked(buildSessionData)).toHaveBeenCalledWith({ top: '5', json: true }, {});
  });
});
