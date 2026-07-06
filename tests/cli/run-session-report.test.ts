import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/build-session-data.js', () => ({
  buildSessionData: vi.fn(async () => ({
    rows: [
      {
        rowType: 'session',
        source: 'pi',
        sessionId: 'session-abcdef123456',
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

    const parsed = JSON.parse(report) as Array<{ sessionId: string; diagnostics?: unknown }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sessionId).toBe('session-abcdef123456');
    expect(parsed[0]).not.toHaveProperty('diagnostics');
  });

  it('renders markdown output when requested', async () => {
    const report = await buildSessionReport({
      markdown: true,
    });

    expect(report).toContain('| Session');
    expect(report).toContain('…abcdef123456');
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

  it('keeps diagnostics on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runSessionReport({
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(stdoutBody) as unknown;
      expect(Array.isArray(parsed)).toBe(true);

      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
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
