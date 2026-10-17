import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import {
  decodeShareReport,
  type ShareReport,
} from '../../../../src/share-report/client/core/index.js';
import type { ShareReportData } from '../../../../src/share-report/types.js';

const FIXTURE_DIR = path.resolve('tests/fixtures/share');

/** A fresh copy of the fixture payload, to edit per test. */
export function readFixturePayload(): { schemaVersion: 1; report: 'share'; data: ShareReportData } {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'payload.json'), 'utf8')) as {
    schemaVersion: 1;
    report: 'share';
    data: ShareReportData;
  };
}

export function readExpectedRollups(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, 'payload.expected.json'), 'utf8'),
  ) as Record<string, unknown>;
}

export function defined<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error('Expected a value');
  }

  return value;
}

export function decodeOrThrow(payload: unknown): ShareReport {
  const result = decodeShareReport(payload);

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.report;
}

export function loadFixtureReport(edit?: (data: ShareReportData) => void): ShareReport {
  const payload = readFixturePayload();
  edit?.(payload.data);
  return decodeOrThrow(payload);
}

/**
 * The host timezones the client is checked under: results must not depend on the browser's
 * zone. Pacific/Apia is UTC+13/+14, so a host-local date differs from UTC for most of the day.
 */
export const HOST_TIMEZONES = ['UTC', 'Pacific/Apia'] as const;

/** Runs the enclosing describe with `process.env.TZ` set, restoring it afterwards. */
export function useHostTimezone(timezone: string): void {
  const previous = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = timezone;
  });

  afterAll(() => {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  });
}
