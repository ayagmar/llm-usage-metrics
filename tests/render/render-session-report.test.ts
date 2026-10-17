import { describe, expect, it } from 'vitest';

import type { SessionDataResult } from '../../src/cli/usage-data-contracts.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import { renderSessionReport } from '../../src/render/render-session-report.js';
import type { SessionTimelineRow } from '../../src/session/session-timeline.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

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
        durationMs: 60 * 60 * 1000,
        activeMs: 5 * 60 * 1000,
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
    projectLabels: new Map([['/home/user/project-alpha', 'project-alpha']]),
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
        firstActivity: '2026-01-01T10:00:00.000Z',
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
        firstActivity: '2026-01-01T11:00:00.000Z',
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
    projectLabels: new Map([
      ['/home/user/project-alpha', 'project-alpha'],
      [undefined, '(unattributed)'],
    ]),
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

  it('wraps a long model id inside the models column instead of overflowing the box', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    data.rows[0].models = ['openrouter/some-provider/a-very-long-model-identifier-v1'];

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });
    const lines = output.split('\n');
    const tableTop = lines.map((line) => line.startsWith('╭')).lastIndexOf(true);
    const borderWidth = visibleWidth(lines[tableTop] ?? '');
    const tableLines = lines.slice(tableTop + 1).filter((line) => line.startsWith('│'));

    expect(tableLines.length).toBeGreaterThan(1);
    for (const line of tableLines) {
      expect(visibleWidth(line)).toBe(borderWidth);
    }
  });

  it('renders the Duration column with hour-minute formatting', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    data.rows[0].durationMs = 134 * 60 * 1000;

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('Duration');
    expect(output).toContain('2h 14m');
  });

  it('renders a dash duration for a single-event session', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    data.rows[0].durationMs = 0;
    data.rows[0].activeMs = 0;
    data.rows[0].eventCount = 1;

    const output = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    const durationColumnRow = output.split('\n').find((line) => line.includes('…abcdef123456'));
    expect(durationColumnRow).toMatch(/│ +- │ 3,340 │/u);
  });

  it('labels sessions without a repo root as unattributed', () => {
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
    expect(output).toContain('(unattributed)');
  });

  it('prints the labels the result carries, which can cover rows it does not show', () => {
    const data = createSessionData();

    if (data.grouping !== 'session') {
      throw new Error('expected session grouping');
    }

    const [row] = data.rows;
    data.rows = [{ ...row, repoRoot: '/home/user/work/app/' }];
    data.projectLabels = new Map([
      ['/home/user/work/app', 'work/app'],
      ['/home/user/oss/app', 'oss/app'],
    ]);

    const output = renderSessionReport(data, 'markdown', { timezone: 'UTC' });

    expect(output).toContain('| work/app');
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
    expect(output).toContain('| Project');
    expect(output).toContain('| Duration');
    expect(output).toContain('1h 0m');
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
      durationMs: 60 * 60 * 1000,
      activeMs: 5 * 60 * 1000,
      eventCount: 2,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      models: ['gpt-4.1', 'gpt-5-codex'],
    });
    expect(parsed.data[0]).not.toHaveProperty('diagnostics');
  });

  it('renders repo rows with project labels, an unattributed bucket, and comma-joined sources', () => {
    const output = renderSessionReport(createRepoData(), 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('Session Usage Report');
    expect(output).toContain('Project');
    expect(output).toContain('Sessions');
    expect(output).toContain('project-alpha');
    expect(output).toContain('(unattributed)');
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
    const filteredOutput = renderSessionReport(data, 'terminal', {
      timezone: 'UTC',
      useColor: false,
      filtered: true,
    });

    expect(output).toContain('Session Usage Report');
    // Without filters, the message must not blame filters the user never passed.
    expect(output).toContain('No usage data found.');
    expect(filteredOutput).toContain('No usage data found for the selected filters.');
  });
});

function createTimelineData(rows: SessionTimelineRow[]): SessionDataResult {
  const sessionData = createSessionData();

  if (sessionData.grouping !== 'session') {
    throw new Error('expected session grouping');
  }

  return {
    grouping: 'timeline',
    session: sessionData.rows[0],
    rows,
    projectLabels: sessionData.projectLabels,
    diagnostics: sessionData.diagnostics,
  };
}

function usageRow(timestamp: string, costUsd: number, runningCostUsd: number): SessionTimelineRow {
  return {
    kind: 'usage',
    timestamp,
    model: 'gpt-5-codex',
    inputTokens: 1_000,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheReadTokens: 3_000,
    cacheWriteTokens: 0,
    totalTokens: 4_200,
    costUsd,
    runningCostUsd,
  };
}

function toolCallRow(name: string, status: 'ok' | 'error' = 'ok'): SessionTimelineRow {
  return { kind: 'tool_call', timestamp: '2026-01-02T01:01:00.000Z', name, status };
}

describe('renderSessionReport --timeline', () => {
  const rows: SessionTimelineRow[] = [
    { kind: 'message', timestamp: '2026-01-02T00:59:00.000Z', role: 'user' },
    usageRow('2026-01-02T01:00:00.000Z', 0.5, 0.5),
    ...['Read', 'Bash', 'Bash', 'Read', 'Bash'].map((name) => toolCallRow(name)),
    toolCallRow('Bash', 'error'),
    { kind: 'message', timestamp: '2026-01-02T01:01:00.000Z', role: 'system' },
    usageRow('2026-01-02T02:00:00.000Z', 0.25, 0.75),
  ];

  it('folds the tool calls between two requests into one line, most-called tool first', () => {
    const output = renderSessionReport(createTimelineData(rows), 'markdown', { timezone: 'UTC' });
    // Markdown pads cells; one space apart is enough to read the cells.
    const lines = output
      .split('\n')
      .slice(2)
      .map((line) => line.replaceAll(/ +/gu, ' '));

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('| 00:59:00 | 1 user turn |');
    expect(lines[1]).toContain('| gpt-5-codex | 1,000 | 3,000 | 0 | 200 | $0.50 | $0.50 |');
    expect(lines[2]).toContain('6 tool calls: Bash ×4, Read ×2, 1 error');
    expect(lines[3]).toContain('$0.25 | $0.75 |');
  });

  it('heads the terminal table with the session, its span, requests and cost', () => {
    const output = renderSessionReport(createTimelineData(rows), 'terminal', {
      timezone: 'UTC',
      useColor: false,
    });

    expect(output).toContain('Session Timeline');
    expect(output).toContain('codex · session-abcdef123456 · project-alpha');
    expect(output).toContain('2026-01-02 01:00-02:00 (1h 0m) · 2 requests · ~$1.23');
  });

  it('lists each row as label and value lines on a narrow terminal', () => {
    const restoreStdout = overrideStdoutTty(60);

    try {
      const output = renderSessionReport(createTimelineData(rows), 'terminal', {
        timezone: 'UTC',
        useColor: false,
      });

      expect(output.split('\n').every((line) => visibleWidth(line) <= 60)).toBe(true);
      expect(output).toContain(
        '01:01:00\n  Event        6 tool calls: Bash ×4, Read ×2,\n               1 error',
      );
    } finally {
      restoreStdout();
    }
  });

  it('prints times of day, with the date on the first row of each later day', () => {
    const output = renderSessionReport(
      createTimelineData([
        usageRow('2026-01-02T23:59:00.000Z', 0.5, 0.5),
        usageRow('2026-01-03T00:01:00.000Z', 0.25, 0.75),
        usageRow('2026-01-03T00:02:00.000Z', 0.25, 1),
      ]),
      'markdown',
      { timezone: 'UTC' },
    );

    expect(
      output
        .split('\n')
        .slice(2)
        .map((line) => line.split(' | ')[0].trimEnd()),
    ).toEqual(['| 23:59:00', '| 2026-01-03 00:01:00', '| 00:02:00']);
  });

  it('renders JSON with every row and its kind, unfolded', () => {
    const output = renderSessionReport(createTimelineData(rows), 'json', { timezone: 'UTC' });
    const data = (JSON.parse(output) as { data: { rows: { kind: string }[] } }).data;

    expect(data.rows.map((row) => row.kind)).toEqual(rows.map((row) => row.kind));
  });
});
