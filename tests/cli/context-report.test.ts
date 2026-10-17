import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContextData } from '../../src/cli/build-context-data.js';
import { buildContextReport, runContextReport } from '../../src/cli/run-context-report.js';
import { freezeDate } from '../golden/golden-harness.js';
import { createContextFixtureAdapters } from '../golden/m12-context-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

describe('context report', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createContextFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true } as const;

  it('covers the last 7 days without date flags, and full history with --all', async () => {
    const recent = await buildContextData(options, deps);
    const all = await buildContextData({ ...options, all: true }, deps);

    expect(recent.defaultWindowSince).toBe('2026-06-15');
    expect(recent.models[0]?.peakPromptTokens).toBe(250_000);
    expect(all.defaultWindowSince).toBeUndefined();
    expect(all.models[0]?.peakPromptTokens).toBe(900_000);
  });

  it('estimates no tier extra under --cost-mode explicit', async () => {
    const data = await buildContextData({ ...options, costMode: 'explicit' }, deps);

    expect(data.models.map((row) => row.longContextExtraUsd)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // Limits do not depend on the cost mode.
    expect(data.models[0]?.contextLimit).toBe(1_048_576);
  });

  it('keeps the top sessions by peak prompt and says how many were left out', async () => {
    const data = await buildContextData({ ...options, bySession: true, top: '1' }, deps);

    expect(data.sessions.map((row) => row.sessionId)).toEqual(['ctx-gemini-big']);
    expect(data.limitNote).toBe('Showing top 1 of 3 sessions by peak prompt. Use --top 0 for all.');
  });

  it('prints the report on stdout and the --top note on stderr', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let printed: string;
    let diagnostics: string;

    try {
      await runContextReport({ ...options, bySession: true, top: '1', json: true }, deps);
      printed = stdout.mock.calls.map((call) => String(call[0])).join('\n');
      diagnostics = stderr.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(JSON.parse(printed)).toMatchObject({ report: 'context', data: { grouping: 'session' } });
    expect(diagnostics).toContain('Showing top 1 of 3 sessions by peak prompt.');
    expect(printed).not.toContain('Showing top');
  });

  it('rejects --top without --by-session', async () => {
    await expect(buildContextReport({ ...options, top: '5' }, deps)).rejects.toThrow(
      '--top applies with --by-session',
    );
  });
});
