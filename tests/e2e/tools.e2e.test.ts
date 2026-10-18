import path from 'node:path';

import type { ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { buildToolsReport } from '../../src/cli/run-tools-report.js';
import type { ToolsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

// Copies of the core readEvents fixtures: real claude, codex and pi logs with tool calls,
// results, errors, unanswered calls and broken rows.
const FIXTURES = path.resolve('tests/fixtures/tools');
const SOURCE_DIRS: ToolsCommandOptions = {
  claudeDir: path.join(FIXTURES, 'claude'),
  codexDir: path.join(FIXTURES, 'codex'),
  piDir: path.join(FIXTURES, 'pi'),
};

type ToolsJson = {
  data: {
    rows: { name: string; source?: string; calls: number; errors: number; unknown: number }[];
    totals: { calls: number; errors: number; unknown: number; sessions: number; tools: number };
  };
};

describe('tools report on real source logs', () => {
  const environment = useIsolatedEnvironment();
  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  async function runTools(options: ToolsCommandOptions): Promise<ToolsJson> {
    const output = await buildToolsReport({
      ...SOURCE_DIRS,
      timezone: 'UTC',
      json: true,
      ...options,
    });
    return validateReportOutput(validators, 'tools', output) as ToolsJson;
  }

  it('counts the tool calls claude, codex and pi log, and matches the schema', async () => {
    const { data } = await runTools({ all: true, bySource: true });

    expect(
      data.rows.map((row) => [row.source, row.name, row.calls, row.errors, row.unknown]),
    ).toEqual([
      ['codex', 'web_search', 3, 1, 1],
      ['codex', 'exec_command', 2, 0, 1],
      ['claude', 'Bash', 1, 0, 0],
      ['claude', 'Grep', 1, 0, 1],
      ['claude', 'Read', 1, 1, 0],
      ['codex', 'apply_patch', 1, 0, 0],
      ['pi', 'bash', 1, 1, 0],
      ['pi', 'grep', 1, 0, 1],
      ['pi', 'read', 1, 0, 0],
    ]);
    // Bash/bash, Grep/grep and Read/read count as one tool each.
    expect(data.totals).toMatchObject({ calls: 12, errors: 3, unknown: 4, sessions: 3, tools: 6 });
  });

  it('keeps the calls of the window only', async () => {
    const { data } = await runTools({ since: '2026-07-01', until: '2026-07-01' });

    expect(data.rows.map((row) => row.name)).toEqual(['Bash', 'Grep', 'Read']);
  });

  it('reports the same calls when the event store serves the usage', async () => {
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(environment.rootDir, 'events.sqlite'));

    try {
      const cold = await runTools({ all: true });
      const warm = await runTools({ all: true });

      expect(warm).toEqual(cold);
      expect(cold.data.totals.calls).toBe(12);
    } finally {
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', undefined);
    }
  });

  it('shows the empty report for a window without calls', async () => {
    const { data } = await runTools({ since: '2020-01-01', until: '2020-01-02' });

    expect(data.rows).toEqual([]);
    expect(data.totals).toMatchObject({ calls: 0, errorRate: null, tools: 0 });
  });
});
