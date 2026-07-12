import { describe, expect, it } from 'vitest';

import type { SessionDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderSessionReport } from '../../src/render/render-session-report.js';

function createDiagnostics(timezone: string): SessionDataResult['diagnostics'] {
  return {
    sessionStats: [],
    sourceFailures: [],
    skippedRows: [],
    pricingOrigin: 'cache',
    activeEnvOverrides: [],
    timezone,
  };
}

function createSessionData(): SessionDataResult {
  return {
    grouping: 'session',
    rows: [
      {
        rowType: 'session',
        source: 'codex',
        sessionId: 'session-abcdef123456',
        repoRoot: '/home/user/project-alpha',
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
    diagnostics: createDiagnostics('America/New_York'),
  };
}

function createRepoData(): SessionDataResult {
  return {
    grouping: 'repo',
    rows: [
      {
        rowType: 'repo',
        repoRoot: '/home/user/project-alpha',
        sessionCount: 3,
        lastActivity: '2026-01-02T02:00:00.000Z',
        sources: ['codex', 'pi'],
        inputTokens: 1_000,
        outputTokens: 2_000,
        reasoningTokens: 0,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        totalTokens: 3_340,
        costUsd: 4.56,
      },
      {
        rowType: 'repo',
        sessionCount: 1,
        lastActivity: '2026-01-01T12:00:00.000Z',
        sources: ['claude'],
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costIncomplete: true,
      },
    ],
    diagnostics: createDiagnostics('UTC'),
  };
}

describe('renderSessionReport', () => {
  it('renders slim terminal output with repo basename and truncated session id', () => {
    const output = renderSessionReport(createSessionData(), 'terminal', {
      timezone: 'America/New_York',
      useColor: false,
    });

    expect(output).toContain('Session Usage Report');
    expect(output).toContain('…abcdef123456');
    expect(output).toContain('project-alpha');
    expect(output).toContain('2026-01-01');
    expect(output).toContain('~$1.23');
    expect(output).toContain('gpt-4.1');
    expect(output).toContain('gpt-5-codex');
    expect(output).not.toContain('Events');
    expect(output).not.toContain('Cache R/W');
  });

  it('renders full session ids when truncation is disabled', () => {
    const output = renderSessionReport(createSessionData(), 'terminal', {
      timezone: 'UTC',
      useColor: false,
      truncateSessionIds: false,
    });

    expect(output).toContain('session-abcdef123456');
    expect(output).not.toContain('…abcdef123456');
  });

  it('caps the models cell at two names plus a +N more marker', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    data.rows[0].models = ['gpt-4.1', 'gpt-5-codex', 'o4-mini', 'o3'];

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('gpt-4.1');
    expect(output).toContain('gpt-5-codex');
    expect(output).toContain('+2 more');
    expect(output).not.toContain('o4-mini');
  });

  it('renders a dash for sessions without a repo root', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    delete data.rows[0].repoRoot;

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).not.toContain('project-alpha');
    expect(output).toContain('│ -');
  });

  it('renders markdown output with session columns and escaped model lines', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    data.rows[0].models = ['[unsafe](https://example.test)', '<tag>'];

    const output = renderSessionReport(data, 'markdown', {
      timezone: 'UTC',
    });

    expect(output).toContain('| Session');
    expect(output).toContain('| Source');
    expect(output).toContain('| Repo');
    expect(output).toContain('…abcdef123456');
    expect(output).toContain('\\[unsafe\\]\\(https\\://example.test\\)<br>&lt;tag&gt;');
    expect(output).not.toContain('[unsafe](https://example.test)');
  });

  it('renders JSON as full data rows only', () => {
    const output = renderSessionReport(createSessionData(), 'json', {
      timezone: 'UTC',
    });
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      report: string;
      data: Array<Record<string, unknown>>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'session' });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]).toMatchObject({
      sessionId: 'session-abcdef123456',
      repoRoot: '/home/user/project-alpha',
      eventCount: 2,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      models: ['gpt-4.1', 'gpt-5-codex'],
    });
    expect(parsed.data[0]).not.toHaveProperty('diagnostics');
  });

  it('renders repo rows with basenames, a no-repo bucket, and comma-joined sources', () => {
    const output = renderSessionReport(createRepoData(), 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('Session Usage Report');
    expect(output).toContain('Repo');
    expect(output).toContain('Sessions');
    expect(output).toContain('project-alpha');
    expect(output).toContain('(no repo)');
    expect(output).toContain('codex, pi');
    expect(output).toContain('$4.56');
    expect(output).not.toContain('/home/user/project-alpha');
  });

  it('renders repo JSON rows with full repo paths', () => {
    const output = renderSessionReport(createRepoData(), 'json', {
      timezone: 'UTC',
    });
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      report: string;
      data: Array<Record<string, unknown>>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'session' });
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toMatchObject({
      rowType: 'repo',
      repoRoot: '/home/user/project-alpha',
      sessionCount: 3,
      sources: ['codex', 'pi'],
    });
    expect(parsed.data[1]).not.toHaveProperty('repoRoot');
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
