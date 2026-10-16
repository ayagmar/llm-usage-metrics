import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { reportSchemas } from '../../src/cli/report-schema-registry.js';
import type {
  ShareCostMode,
  ShareReportData,
  ShareTokenBuckets,
} from '../../src/share-report/types.js';
import { addUsd } from '../../src/utils/usd-math.js';

// The hand-written payload the client tests run against, and its expected roll-ups.
const FIXTURE_DIR = path.resolve('tests/fixtures/share');
const COST_MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];

type ExpectedTotals = ShareTokenBuckets & {
  key?: string;
  eventCount: number;
  activeMs: number;
  costs: Record<ShareCostMode, { costUsd: number | null; incompleteEvents: number }>;
};

type ExpectedRollups = Record<
  'hour' | 'day' | 'week' | 'month' | 'bySource' | 'byModel' | 'byProject' | 'byMachine',
  ExpectedTotals[]
> & { total: ExpectedTotals };

const TOTAL_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'eventCount',
  'activeMs',
] as const;

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

function compileShareSchema() {
  return new Ajv2020({ allErrors: true, strict: true }).compile(reportSchemas.share as object);
}

function sumTotals(rows: readonly ExpectedTotals[]): ExpectedTotals {
  const total: ExpectedTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    activeMs: 0,
    costs: {
      explicit: { costUsd: null, incompleteEvents: 0 },
      estimated: { costUsd: null, incompleteEvents: 0 },
      both: { costUsd: null, incompleteEvents: 0 },
    },
  };

  for (const row of rows) {
    for (const field of TOTAL_FIELDS) {
      total[field] += row[field];
    }

    for (const mode of COST_MODES) {
      const cost = row.costs[mode];
      total.costs[mode].incompleteEvents += cost.incompleteEvents;

      if (cost.costUsd !== null) {
        total.costs[mode].costUsd = addUsd(total.costs[mode].costUsd ?? 0, cost.costUsd);
      }
    }
  }

  return total;
}

describe('share fixture payload', () => {
  it('is valid against the share schema', async () => {
    const validate = compileShareSchema();

    expect(validate(await readFixture('payload.json')), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a session that carries its session ID', async () => {
    const payload = (await readFixture('payload.json')) as { data: ShareReportData };
    Object.assign(payload.data.sessions.rows[0], { sessionId: 'abc' });

    expect(compileShareSchema()(payload)).toBe(false);
  });

  it('has one value per cell in every cube column and only valid indexes', async () => {
    const { data } = (await readFixture('payload.json')) as { data: ShareReportData };
    const { cube, dictionaries } = data;
    const cellCount = cube.period.length;
    const columns = [
      ...TOTAL_FIELDS.map((field) => cube[field]),
      cube.source,
      cube.model,
      cube.project,
      cube.machine,
      ...COST_MODES.flatMap((mode) => [
        cube.costs[mode]?.costUsd ?? [],
        cube.costs[mode]?.incompleteEvents ?? [],
      ]),
    ];

    expect(cellCount).toBeGreaterThan(0);
    expect(columns.map((column) => column.length)).toEqual(columns.map(() => cellCount));

    const indexed: [readonly number[], readonly string[]][] = [
      [cube.period, dictionaries.periods],
      [cube.source, dictionaries.sources],
      [cube.model, dictionaries.models],
      [cube.project, dictionaries.projects],
      [cube.machine, dictionaries.machines],
      [data.sessions.rows.map((row) => row.source), dictionaries.sources],
      [data.sessions.rows.map((row) => row.project), dictionaries.projects],
      [data.sessions.rows.flatMap((row) => row.machines), dictionaries.machines],
      [data.sessions.rows.flatMap((row) => row.models), dictionaries.models],
      [data.blocks.rows.map((row) => row.source), dictionaries.sources],
      [data.blocks.rows.flatMap((row) => row.models), dictionaries.models],
    ];

    for (const [indexes, dictionary] of indexed) {
      expect(indexes.every((index) => index < dictionary.length)).toBe(true);
    }
  });

  it('expects roll-ups that each add up to the cube total', async () => {
    const { data } = (await readFixture('payload.json')) as { data: ShareReportData };
    const expected = (await readFixture('payload.expected.json')) as ExpectedRollups;
    const { cube } = data;
    const cellTotals: ExpectedTotals[] = cube.period.map((_, cell) => ({
      inputTokens: cube.inputTokens[cell] ?? 0,
      outputTokens: cube.outputTokens[cell] ?? 0,
      reasoningTokens: cube.reasoningTokens[cell] ?? 0,
      cacheReadTokens: cube.cacheReadTokens[cell] ?? 0,
      cacheWriteTokens: cube.cacheWriteTokens[cell] ?? 0,
      totalTokens: cube.totalTokens[cell] ?? 0,
      eventCount: cube.eventCount[cell] ?? 0,
      activeMs: cube.activeMs[cell] ?? 0,
      costs: {
        explicit: {
          costUsd: cube.costs.explicit?.costUsd[cell] ?? null,
          incompleteEvents: cube.costs.explicit?.incompleteEvents[cell] ?? 0,
        },
        estimated: {
          costUsd: cube.costs.estimated?.costUsd[cell] ?? null,
          incompleteEvents: cube.costs.estimated?.incompleteEvents[cell] ?? 0,
        },
        both: {
          costUsd: cube.costs.both?.costUsd[cell] ?? null,
          incompleteEvents: cube.costs.both?.incompleteEvents[cell] ?? 0,
        },
      },
    }));

    expect(expected.total).toEqual(sumTotals(cellTotals));

    for (const rollup of [
      'day',
      'week',
      'month',
      'bySource',
      'byModel',
      'byProject',
      'byMachine',
    ] as const) {
      expect(sumTotals(expected[rollup]), rollup).toEqual(expected.total);
    }

    const hourlyCells = cellTotals.filter((_, cell) =>
      (data.dictionaries.periods[cube.period[cell] ?? -1] ?? '').includes(' '),
    );
    expect(sumTotals(expected.hour)).toEqual(sumTotals(hourlyCells));
    expect(expected.hour.every((row) => (row.key ?? '') >= (data.meta.hourlyFrom ?? ''))).toBe(
      true,
    );
  });
});
