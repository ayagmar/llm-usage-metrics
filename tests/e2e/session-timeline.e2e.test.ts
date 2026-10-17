import path from 'node:path';

import type { ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildSessionReport } from '../../src/cli/run-session-report.js';
import type { SessionCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

// The tools report's fixtures: real claude, codex and pi logs with tool calls and turns.
const FIXTURES = path.resolve('tests/fixtures/tools');
const SOURCE_OPTIONS: SessionCommandOptions = {
  claudeDir: path.join(FIXTURES, 'claude'),
  codexDir: path.join(FIXTURES, 'codex'),
  piDir: path.join(FIXTURES, 'pi'),
  source: 'claude,codex,pi',
  timezone: 'UTC',
};

type TimelineRow = { timestamp: string; kind: string; name?: string; status?: string };

describe('session --timeline on real source logs', () => {
  useIsolatedEnvironment();
  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  async function runTimeline(id: string): Promise<TimelineRow[]> {
    const output = await buildSessionReport({
      ...SOURCE_OPTIONS,
      id: [id],
      timeline: true,
      json: true,
    });
    const report = validateReportOutput(validators, 'session', output) as {
      data: { rows: TimelineRow[] };
    };
    return report.data.rows;
  }

  /** `usage`, `message`, or the tool call's `name:status`, in row order. */
  function describeRows(rows: readonly TimelineRow[]): string[] {
    return rows.map((row) => (row.kind === 'tool_call' ? `${row.name}:${row.status}` : row.kind));
  }

  it('places each claude tool call after the request that made it, between the turns', async () => {
    expect(describeRows(await runTimeline('evt-session'))).toEqual([
      'message',
      'message',
      'usage',
      'Bash:ok',
      'usage',
      'Read:error',
      'usage',
      'Grep:unknown',
      'message',
      'message',
      'usage',
    ]);
  });

  it('interleaves codex tool calls with its requests, counting a repeated call once', async () => {
    const rows = await runTimeline('codex-events');

    expect(describeRows(rows)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'exec_command:ok',
      'apply_patch:ok',
      'web_search:ok',
      'web_search:error',
      'web_search:unknown',
      'usage',
      'exec_command:unknown',
      'message',
      'message',
      'usage',
    ]);
    expect(rows.map((row) => row.timestamp)).toEqual(rows.map((row) => row.timestamp).sort());
  });

  it('refuses an id several sessions share, listing them', async () => {
    await expect(
      buildSessionReport({ ...SOURCE_OPTIONS, id: ['session'], timeline: true }),
    ).rejects.toThrow(
      [
        '--timeline needs exactly one session, but --id session matches 2:',
        '  claude  evt-session           2026-07-01',
        '  codex   codex-events-session  2026-10-01',
        'Pass more of the session id to --id.',
      ].join('\n'),
    );
  });
});
