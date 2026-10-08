import { mkdir, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { buildSessionReport } from '../../src/cli/run-session-report.js';
import { buildSummaryReport } from '../../src/cli/run-summary-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { buildWrappedReport } from '../../src/cli/run-wrapped-report.js';
import { runDoctorReport } from '../../src/cli/run-doctor-report.js';
import { runPruneReport } from '../../src/cli/run-prune-report.js';
import { reportSchemas } from '../../src/cli/report-schema-registry.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const fixtureOptions = {
  piDir,
  codexDir,
  source: 'pi,codex',
  timezone: 'UTC',
  json: true,
} as const;

const validators = new Map<string, ValidateFunction>();
const tempDirs: string[] = [];

const reportNamesOnDisk: string[] = [];

async function loadValidators(): Promise<void> {
  const schemaFiles = (await readdir(path.resolve('schema'))).filter(
    (name) => name.startsWith('report-') && name.endsWith('.v1.schema.json'),
  );

  for (const name of schemaFiles) {
    const reportName = name.replace('report-', '').replace('.v1.schema.json', '');

    if (reportName !== 'common') {
      reportNamesOnDisk.push(reportName);
    }
  }

  // Compile what `llm-usage schema <report>` prints, alone and in strict mode, so the
  // printed schemas are proven self-contained against real report output.
  for (const [reportName, schema] of Object.entries(reportSchemas)) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    validators.set(reportName, ajv.compile(schema as object));
  }
}

function validateReport(reportName: string, output: string): unknown {
  const validate = validators.get(reportName);

  if (!validate) {
    throw new Error(`No validator for report ${reportName}`);
  }

  const parsed: unknown = JSON.parse(output);
  const valid = validate(parsed);

  expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  expect(valid).toBe(true);
  return parsed;
}

async function captureJsonStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(String(args[0]));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    await run();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return chunks.join('');
}

function compactJson(output: string): string {
  return JSON.stringify(JSON.parse(output));
}

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function createStoreWithDepartedEvent(dbPath: string): Promise<void> {
  const store = await openEventStore(dbPath);

  try {
    replaceFileEvents(store, {
      source: 'codex',
      filePath: '/tmp/departed.jsonl',
      fingerprint: {
        dependencies: [{ path: '/tmp/departed.jsonl', exists: true, size: 10, mtimeMs: 20 }],
      },
      events: [
        createUsageEvent({
          source: 'codex',
          sessionId: 'schema-departed-session',
          timestamp: '2025-01-01T00:00:00.000Z',
          model: 'gpt-4.1',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      ],
      skippedRows: 0,
      now: 1_000,
    });
  } finally {
    closeEventStore(store);
  }
}

const noFilesAdapter: SourceAdapter = {
  id: 'codex',
  discoverFiles: async () => [],
  parseFile: async () => [],
};

beforeAll(async () => {
  await loadValidators();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('report json schema e2e', () => {
  it('registers every report schema file in the schema registry', () => {
    expect(reportNamesOnDisk.sort()).toEqual(Object.keys(reportSchemas).sort());
  });

  it('validates usage output', async () => {
    const output = await buildUsageReport('monthly', { ...fixtureOptions });
    validateReport('usage', output);
  });

  it('validates session output', async () => {
    const output = await buildSessionReport({ ...fixtureOptions });
    validateReport('session', output);
  });

  it('validates trends output', async () => {
    const output = await buildTrendsReport({
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-01-31',
      metric: 'tokens',
    });
    validateReport('trends', output);
  });

  it('validates trends active-hours output', async () => {
    const output = await buildTrendsReport({
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-01-31',
      metric: 'active-hours',
    });
    validateReport('trends', output);
  });

  it('validates summary output', async () => {
    const output = await buildSummaryReport(
      { ...fixtureOptions, pricingOffline: true },
      { now: () => new Date('2026-02-28T12:00:00.000Z') },
    );
    expect(
      (JSON.parse(output) as { data: { periods: Array<{ totals: { events: number } }> } }).data
        .periods[2]?.totals.events,
    ).toBeGreaterThan(0);
    validateReport('summary', output);
  });

  it('validates compare output', async () => {
    const output = await buildCompareReport({
      ...fixtureOptions,
      since: '2026-02-01',
      until: '2026-02-28',
      vsSince: '2026-01-01',
      vsUntil: '2026-01-31',
      pricingOffline: true,
    });
    validateReport('compare', output);
  });

  it('validates efficiency output', async () => {
    const output = await buildEfficiencyReport('monthly', {
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-06-30',
      pricingOffline: true,
    });
    validateReport('efficiency', output);
  });

  it('validates optimize output', async () => {
    const output = await buildOptimizeReport('monthly', {
      ...fixtureOptions,
      provider: 'openai',
      candidateModel: ['definitely-missing-model'],
      ignorePricingFailures: true,
    });
    validateReport('optimize', output);
  });

  it('validates wrapped output', async () => {
    const output = await buildWrappedReport({ ...fixtureOptions, year: '2026' });
    validateReport('wrapped', output);
  });

  it('validates doctor output', async () => {
    const output = await captureJsonStdout(() =>
      runDoctorReport(
        { ...fixtureOptions },
        {
          getEventStoreRuntimeConfig: () => ({
            enabled: false as const,
            path: '/tmp/report-schema-unused-store.db',
            disabledBy: 'environment' as const,
          }),
        },
      ),
    );
    validateReport('doctor', output);
  });

  it('validates prune output', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'report-schema-prune-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    const store = await openEventStore(dbPath);

    try {
      replaceFileEvents(store, {
        source: 'codex',
        filePath: '/tmp/departed.jsonl',
        fingerprint: {
          dependencies: [{ path: '/tmp/departed.jsonl', exists: true, size: 10, mtimeMs: 20 }],
        },
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'schema-prune-session',
            timestamp: '2025-01-01T00:00:00.000Z',
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          }),
        ],
        skippedRows: 0,
        now: 1_000,
      });
    } finally {
      closeEventStore(store);
    }

    const adapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => [],
      parseFile: async () => [],
    };
    const output = await captureJsonStdout(() =>
      runPruneReport(
        { suppressed: true, departedBefore: '2026-01-01', json: true },
        {
          createAdapters: () => [adapter],
          getEventStoreRuntimeConfig: () => ({ enabled: true, path: dbPath }),
        },
      ),
    );
    validateReport('prune', output);
  });

  it('validates daily and weekly usage output', async () => {
    const expectedPeriodKeys = {
      daily: '"periodKey":"2026-01-05"',
      weekly: '"periodKey":"2026-W02"',
    };

    for (const granularity of ['daily', 'weekly'] as const) {
      const output = await buildUsageReport(granularity, { ...fixtureOptions, all: true });
      validateReport('usage', output);
      expect(compactJson(output)).toContain(expectedPeriodKeys[granularity]);
    }
  });

  it('validates session output grouped by repo', async () => {
    const output = await buildSessionReport({ ...fixtureOptions, byRepo: true });
    validateReport('session', output);
    expect(compactJson(output)).toContain('"rowType":"repo"');
  });

  it('validates efficiency output by source', async () => {
    const output = await buildEfficiencyReport('monthly', {
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-06-30',
      pricingOffline: true,
      bySource: true,
    });
    validateReport('efficiency', output);
    expect(compactJson(output)).toContain('"grouping":"source"');
  });

  it('validates trends output by source and with the cost metric', async () => {
    const bySource = await buildTrendsReport({
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-02-28',
      metric: 'tokens',
      bySource: true,
    });
    validateReport('trends', bySource);
    expect(compactJson(bySource)).toContain('"source":"codex"');
    expect(compactJson(bySource)).toContain('"source":"pi"');

    const cost = await buildTrendsReport({
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-02-28',
      metric: 'cost',
      pricingOffline: true,
    });
    validateReport('trends', cost);
    expect(compactJson(cost)).toContain('"metric":"cost"');
  });

  it('validates optimize output with a resolvable candidate model', async () => {
    const output = await buildOptimizeReport('monthly', {
      ...fixtureOptions,
      since: '2026-01-01',
      until: '2026-06-30',
      candidateModel: ['gpt-5-codex'],
      pricingOffline: true,
    });
    validateReport('optimize', output);
    expect(compactJson(output)).toContain('"candidateResolvedModel":"gpt-5-codex"');
  });

  it('validates doctor output with the event store enabled', async () => {
    const tempDir = await createTempDir('report-schema-doctor-');
    const dbPath = path.join(tempDir, 'events.db');
    await createStoreWithDepartedEvent(dbPath);

    const output = await captureJsonStdout(() =>
      runDoctorReport(
        { ...fixtureOptions },
        { getEventStoreRuntimeConfig: () => ({ enabled: true, path: dbPath }) },
      ),
    );
    validateReport('doctor', output);
    expect(compactJson(output)).toContain('"id":"event-store"');
  });

  it('validates prune output with --departed-before and --apply', async () => {
    const tempDir = await createTempDir('report-schema-prune-apply-');
    const dbPath = path.join(tempDir, 'events.db');
    await createStoreWithDepartedEvent(dbPath);
    const deps = {
      createAdapters: () => [noFilesAdapter],
      getEventStoreRuntimeConfig: () => ({ enabled: true as const, path: dbPath }),
    };

    const dryRun = await captureJsonStdout(() =>
      runPruneReport({ departedBefore: '2026-01-01', json: true }, deps),
    );
    validateReport('prune', dryRun);
    expect(compactJson(dryRun)).toContain('/tmp/departed.jsonl');
    expect(compactJson(dryRun)).toContain('"applied":false');

    const applied = await captureJsonStdout(() =>
      runPruneReport({ departedBefore: '2026-01-01', apply: true, json: true }, deps),
    );
    validateReport('prune', applied);
    expect(compactJson(applied)).toContain('"applied":true');
  });

  it('validates a report whose cost is incomplete', async () => {
    const tempDir = await createTempDir('report-schema-unpriced-');
    const piUnpricedDir = path.join(tempDir, 'pi');
    await mkdir(piUnpricedDir);
    await writeFile(
      path.join(piUnpricedDir, 'session.jsonl'),
      [
        '{"type":"session","id":"unpriced-session","timestamp":"2026-01-04T09:00:00.000Z"}',
        '{"type":"message","timestamp":"2026-01-04T09:10:00.000Z","provider":"nobody","model":"definitely-unpriced-model","usage":{"input":10,"output":5,"totalTokens":15}}',
      ].join('\n'),
    );

    const output = await buildUsageReport('monthly', {
      piDir: piUnpricedDir,
      source: 'pi',
      timezone: 'UTC',
      json: true,
      pricingOffline: true,
    });
    validateReport('usage', output);
    expect(compactJson(output)).toContain('"costIncomplete":true');
  });

  it('validates usage output with --history reading a temp store', async () => {
    const tempDir = await createTempDir('report-schema-history-');
    const dbPath = path.join(tempDir, 'events.db');
    await createStoreWithDepartedEvent(dbPath);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', dbPath);

    try {
      const output = await buildUsageReport('monthly', {
        ...fixtureOptions,
        history: true,
        pricingOffline: true,
      });
      validateReport('usage', output);
      expect(compactJson(output)).toContain('2025-01');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails validation when schemaVersion is removed (negative control)', async () => {
    const output = await buildUsageReport('monthly', { ...fixtureOptions });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    delete parsed.schemaVersion;

    const validate = validators.get('usage');
    expect(validate?.(parsed)).toBe(false);
  });
});
