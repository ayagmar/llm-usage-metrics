import { afterEach, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => eventsByFile[filePath] ?? [],
  };
}

function runtimeDeps(adapters: SourceAdapter[]) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 2,
      parseWorkers: 0,
      parseWorkerMinBytes: 268_435_456,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({
      enabled: false as const,
      path: '/tmp/events.db',
      disabledBy: 'environment' as const,
    }),
    getActiveEnvVarOverrides: () => [],
    createAdapters: () => adapters,
    resolvePricingSource: async (): Promise<PricingLoadResult> => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache',
    }),
  };
}

function fixtureAdapters(): SourceAdapter[] {
  return [
    createAdapter('pi', {
      '/tmp/pi.jsonl': [
        // Out of timestamp order on purpose: export must sort.
        createUsageEvent({
          source: 'pi',
          sessionId: 'pi-session',
          timestamp: '2026-02-01T12:00:00.000Z',
          provider: 'openai',
          model: 'gpt-4.1',
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costUsd: 0.2,
        }),
        createUsageEvent({
          source: 'pi',
          sessionId: 'pi-session',
          timestamp: '2026-01-01T10:00:00.000Z',
          repoRoot: '/home/user/repo,with-comma',
          provider: 'openai',
          model: 'gpt-4.1',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costUsd: 0.1,
        }),
      ],
    }),
    createAdapter('codex', {
      '/tmp/codex.jsonl': [
        createUsageEvent({
          source: 'codex',
          sessionId: 'codex-session',
          timestamp: '2026-01-15T09:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5-codex',
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        }),
      ],
    }),
  ];
}

function captureOutput() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrChunks.push(args.join(' '));
  });

  return {
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join('\n'),
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run-events-report', () => {
  it('streams jsonl lines sorted by timestamp, source, session id', async () => {
    const output = captureOutput();

    try {
      await runEventsReport({ timezone: 'UTC' }, runtimeDeps(fixtureAdapters()));
    } finally {
      output.restore();
    }

    const lines = output.stdout().trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({
      source: 'pi',
      timestamp: '2026-01-01T10:00:00.000Z',
      repoRoot: '/home/user/repo,with-comma',
      costUsd: 0.1,
      costMode: 'explicit',
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      source: 'codex',
      timestamp: '2026-01-15T09:00:00.000Z',
      model: 'gpt-5-codex',
    });
    expect(JSON.parse(lines[2])).toMatchObject({
      source: 'pi',
      timestamp: '2026-02-01T12:00:00.000Z',
    });
    // Omitted optionals stay omitted, not null.
    expect(lines[1]).not.toContain('repoRoot');
  });

  it('streams csv with the frozen header and RFC 4180 quoting', async () => {
    const output = captureOutput();

    try {
      await runEventsReport({ timezone: 'UTC', format: 'csv' }, runtimeDeps(fixtureAdapters()));
    } finally {
      output.restore();
    }

    const lines = output.stdout().trimEnd().split('\n');

    expect(lines[0]).toBe(
      'source,sessionId,timestamp,repoRoot,provider,model,inputTokens,outputTokens,reasoningTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costUsd,costMode',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"/home/user/repo,with-comma"');
    // Absent optionals render as empty fields.
    expect(lines[2]).toContain(',,openai,');
  });

  it('rejects --json with a pointer to --format jsonl', async () => {
    await expect(runEventsReport({ json: true }, runtimeDeps([]))).rejects.toThrow(
      '--json is not supported for events; use --format jsonl',
    );
  });

  it('rejects unknown formats', async () => {
    await expect(runEventsReport({ format: 'tsv' }, runtimeDeps([]))).rejects.toThrow(
      '--format must be one of: jsonl, csv',
    );
  });

  it('keeps stdout data-only with diagnostics on stderr', async () => {
    const output = captureOutput();

    try {
      await runEventsReport({ timezone: 'UTC' }, runtimeDeps(fixtureAdapters()));
    } finally {
      output.restore();
    }

    for (const line of output.stdout().trimEnd().split('\n')) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }

    expect(output.stderr()).toContain('session file(s)');
  });
});
