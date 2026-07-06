import { describe, expect, it } from 'vitest';

import type { SessionDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderSessionReport } from '../../src/render/render-session-report.js';

function createSessionData(): SessionDataResult {
  return {
    rows: [
      {
        rowType: 'session',
        source: 'codex',
        sessionId: 'session-abcdef123456',
        firstActivity: '2026-01-02T01:00:00.000Z',
        lastActivity: '2026-01-02T02:00:00.000Z',
        eventCount: 2,
        models: ['gpt-4.1', 'gpt-5-codex'],
        inputTokens: 1_000,
        outputTokens: 2_000,
        reasoningTokens: 0,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        totalTokens: 3_340,
        costUsd: 1.23,
        costIncomplete: true,
      },
    ],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'cache',
      activeEnvOverrides: [],
      timezone: 'America/New_York',
    },
  };
}

describe('renderSessionReport', () => {
  it('renders terminal output with title, local date, truncated session id, and approximate cost', () => {
    const output = renderSessionReport(createSessionData(), 'terminal', {
      timezone: 'America/New_York',
      useColor: false,
    });

    expect(output).toContain('Session Usage Report');
    expect(output).toContain('…abcdef123456');
    expect(output).toContain('2026-01-01');
    expect(output).toContain('~$1.23');
    expect(output).toContain('gpt-4.1');
    expect(output).toContain('gpt-5-codex');
  });

  it('renders markdown output with session columns and escaped model lines', () => {
    const data = createSessionData();
    data.rows[0].models = ['[unsafe](https://example.test)', '<tag>'];

    const output = renderSessionReport(data, 'markdown', {
      timezone: 'UTC',
    });

    expect(output).toContain('| Session');
    expect(output).toContain('| Source');
    expect(output).toContain('…abcdef123456');
    expect(output).toContain('\\[unsafe\\]\\(https\\://example.test\\)<br>&lt;tag&gt;');
    expect(output).not.toContain('[unsafe](https://example.test)');
  });

  it('renders JSON as full data rows only', () => {
    const output = renderSessionReport(createSessionData(), 'json', {
      timezone: 'UTC',
    });
    const parsed = JSON.parse(output) as Array<{ sessionId: string; diagnostics?: unknown }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sessionId).toBe('session-abcdef123456');
    expect(parsed[0]).not.toHaveProperty('diagnostics');
  });

  it('renders an empty terminal state when no rows are available', () => {
    const data = createSessionData();
    data.rows = [];

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('Session Usage Report');
    expect(output).toContain('No usage data found for the selected filters.');
  });
});
