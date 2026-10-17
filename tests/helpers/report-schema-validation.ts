import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { expect, vi } from 'vitest';

import { reportSchemas } from '../../src/cli/report-schema-registry.js';

/** The report names of `schema/report-<name>.v1.schema.json`, without `common`. */
export async function listReportSchemaNamesOnDisk(): Promise<string[]> {
  return (await readdir(path.resolve('schema')))
    .filter((name) => name.startsWith('report-') && name.endsWith('.v1.schema.json'))
    .map((name) => name.replace('report-', '').replace('.v1.schema.json', ''))
    .filter((reportName) => reportName !== 'common');
}

/**
 * Compiles what `llm-usage schema <report>` prints, each alone and in strict mode, so the
 * printed schemas are proven self-contained against real report output.
 */
export function compileReportValidators(): Map<string, ValidateFunction> {
  const validators = new Map<string, ValidateFunction>();

  for (const [reportName, schema] of Object.entries(reportSchemas)) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    validators.set(reportName, ajv.compile(schema as object));
  }

  return validators;
}

/** Validates a report's JSON output against its schema and returns the parsed output. */
export function validateReportOutput(
  validators: ReadonlyMap<string, ValidateFunction>,
  reportName: string,
  output: string,
): unknown {
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

/** What a report prints with `console.log`; stderr is dropped. */
export async function captureJsonStdout(run: () => Promise<void>): Promise<string> {
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

export function compactJson(output: string): string {
  return JSON.stringify(JSON.parse(output));
}
