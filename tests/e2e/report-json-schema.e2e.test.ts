import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildOptimizeReport } from '../../src/cli/run-optimize-report.js';
import { buildSessionReport } from '../../src/cli/run-session-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { buildWrappedReport } from '../../src/cli/run-wrapped-report.js';
import { runDoctorReport } from '../../src/cli/run-doctor-report.js';
import { runPruneReport } from '../../src/cli/run-prune-report.js';
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

async function loadValidators(): Promise<void> {
  const ajv = new Ajv2020({ allErrors: true });
  const schemaDir = path.resolve('schema');
  const schemaFiles = (await readdir(schemaDir)).filter(
    (name) => name.startsWith('report-') && name.endsWith('.v1.schema.json'),
  );

  for (const name of schemaFiles) {
    const schema = JSON.parse(await readFile(path.join(schemaDir, name), 'utf8')) as Record<
      string,
      unknown
    >;
    ajv.addSchema(schema);
  }

  for (const name of schemaFiles) {
    const reportName = name.replace('report-', '').replace('.v1.schema.json', '');

    if (reportName === 'common') {
      continue;
    }

    const validate = ajv.getSchema(
      `https://ayagmar.github.io/llm-usage-metrics/report-${reportName}.v1.schema.json`,
    );

    if (!validate) {
      throw new Error(`Schema for report ${reportName} did not register`);
    }

    validators.set(reportName, validate);
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

beforeAll(async () => {
  await loadValidators();
});

afterAll(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('report json schema e2e', () => {
  it('registers a validator for all nine reports', () => {
    expect([...validators.keys()].sort()).toEqual([
      'compare',
      'doctor',
      'efficiency',
      'optimize',
      'prune',
      'session',
      'trends',
      'usage',
      'wrapped',
    ]);
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

  it('fails validation when schemaVersion is removed (negative control)', async () => {
    const output = await buildUsageReport('monthly', { ...fixtureOptions });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    delete parsed.schemaVersion;

    const validate = validators.get('usage');
    expect(validate?.(parsed)).toBe(false);
  });
});
