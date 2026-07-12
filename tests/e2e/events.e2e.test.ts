import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');

const CSV_HEADER =
  'source,sessionId,timestamp,repoRoot,provider,model,inputTokens,outputTokens,reasoningTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costUsd,costMode';

async function loadLineValidator() {
  const ajv = new Ajv2020({ allErrors: true });

  for (const name of ['report-common.v1.schema.json', 'events-line.v1.schema.json']) {
    const schema = JSON.parse(await readFile(path.resolve('schema', name), 'utf8')) as Record<
      string,
      unknown
    >;
    ajv.addSchema(schema);
  }

  const validate = ajv.getSchema(
    'https://ayagmar.github.io/llm-usage-metrics/events-line.v1.schema.json',
  );

  if (!validate) {
    throw new Error('events line schema did not register');
  }

  return validate;
}

async function captureEventsStdout(options: EventsCommandOptions): Promise<string[]> {
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    await runEventsReport({ piDir, codexDir, timezone: 'UTC', ...options });
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const output = chunks.join('');
  return output.length === 0 ? [] : output.trimEnd().split('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('events export e2e', () => {
  it('streams jsonl lines that validate against the published line schema', async () => {
    const validate = await loadLineValidator();
    const lines = await captureEventsStdout({ source: 'pi,codex' });

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      const valid = validate(parsed);

      expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
      expect(valid).toBe(true);
    }
  });

  it('streams csv with the frozen header and one row per jsonl line', async () => {
    const jsonlLines = await captureEventsStdout({ source: 'pi,codex' });
    const csvLines = await captureEventsStdout({ source: 'pi,codex', format: 'csv' });

    expect(csvLines[0]).toBe(CSV_HEADER);
    expect(csvLines.length - 1).toBe(jsonlLines.length);
  });

  it('shrinks the output under --since and --source filters', async () => {
    const allLines = await captureEventsStdout({ source: 'pi,codex' });
    const piLines = await captureEventsStdout({ source: 'pi' });
    const laterLines = await captureEventsStdout({ source: 'pi,codex', since: '2026-06-01' });

    expect(piLines.length).toBeGreaterThan(0);
    expect(piLines.length).toBeLessThan(allLines.length);
    expect(laterLines.length).toBeLessThan(allLines.length);

    for (const line of piLines) {
      expect((JSON.parse(line) as { source: string }).source).toBe('pi');
    }
  });
});
