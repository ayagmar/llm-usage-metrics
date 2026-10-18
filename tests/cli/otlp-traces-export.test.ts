import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import { runToolsReport } from '../../src/cli/run-tools-report.js';
import type {
  BuildUsageDataDeps,
  EventsCommandOptions,
} from '../../src/cli/usage-data-contracts.js';
import type { UsageEvent } from '../../src/domain/usage-event.js';
import type { OtlpSpan, OtlpTracesData } from '../../src/otel-export/otlp-traces.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

// Real claude, codex and pi logs with tool calls, also used by the tools and timeline goldens.
const FIXTURES = path.resolve('tests/fixtures/tools');
const FIXTURE_OPTIONS = {
  claudeDir: path.join(FIXTURES, 'claude'),
  codexDir: path.join(FIXTURES, 'codex'),
  piDir: path.join(FIXTURES, 'pi'),
  source: 'claude,codex,pi',
  timezone: 'UTC',
  pricingOffline: true,
};
const NOW = () => new Date('2026-07-01T00:00:00.000Z');

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.join(' ')}\n`);
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }

  return chunks.join('');
}

function exportEvents(
  options: EventsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  return captureStdout(() =>
    runEventsReport({ ...FIXTURE_OPTIONS, ...options }, { now: NOW, ...deps }),
  );
}

function parseLines<T>(output: string): T[] {
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function spansOf(data: OtlpTracesData) {
  return data.resourceSpans[0].scopeSpans[0].spans;
}

function attribute(span: OtlpSpan, key: string): unknown {
  const value = span.attributes.find((entry) => entry.key === key)?.value;
  return value === undefined ? undefined : (Object.values(value) as unknown[])[0];
}

describe('events --format otlp-traces', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the same bytes on a re-run, from a cold store, a warm store and no store', async () => {
    const storeDeps: BuildUsageDataDeps = {
      getEventStoreRuntimeConfig: () => ({
        enabled: true,
        path: path.join(environment.rootDir, 'determinism', 'events.db'),
      }),
    };
    const noStoreDeps: BuildUsageDataDeps = {
      getEventStoreRuntimeConfig: () => ({
        enabled: false,
        path: '',
        disabledBy: 'environment',
      }),
    };

    const cold = await exportEvents({ format: 'otlp-traces' }, storeDeps);
    const warm = await exportEvents({ format: 'otlp-traces' }, storeDeps);
    const noStore = await exportEvents({ format: 'otlp-traces' }, noStoreDeps);

    expect(cold.length).toBeGreaterThan(0);
    expect(warm).toBe(cold);
    expect(noStore).toBe(cold);
  });

  it('builds one trace per session with a chat span per usage event and session sums on the root', async () => {
    const events = parseLines<UsageEvent>(await exportEvents({ format: 'jsonl' }));
    const traces = parseLines<OtlpTracesData>(await exportEvents({ format: 'otlp-traces' }));
    const sessions = new Set(events.map((event) => `${event.source}/${event.sessionId}`));

    expect(traces).toHaveLength(sessions.size);

    for (const data of traces) {
      const [root, ...children] = spansOf(data);
      const sessionId = attribute(root, 'gen_ai.conversation.id');
      const sessionEvents = events.filter((event) => event.sessionId === sessionId);
      const chats = children.filter((span) => span.name.startsWith('chat'));

      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/u);
      expect(root.spanId).toMatch(/^[0-9a-f]{16}$/u);
      expect(root.parentSpanId).toBeUndefined();
      expect(new Set(children.map((span) => span.traceId))).toEqual(new Set([root.traceId]));
      expect(new Set(children.map((span) => span.parentSpanId))).toEqual(new Set([root.spanId]));
      expect(new Set(spansOf(data).map((span) => span.spanId)).size).toBe(children.length + 1);
      expect(chats).toHaveLength(sessionEvents.length);
      expect(attribute(root, 'gen_ai.usage.input_tokens')).toBe(
        String(
          sessionEvents.reduce(
            (sum, event) =>
              sum + event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens,
            0,
          ),
        ),
      );
      expect(attribute(root, 'gen_ai.usage.output_tokens')).toBe(
        String(sessionEvents.reduce((sum, event) => sum + event.outputTokens, 0)),
      );

      for (const chat of chats) {
        expect(chat.startTimeUnixNano).toBe(chat.endTimeUnixNano);
        expect(BigInt(chat.startTimeUnixNano) >= BigInt(root.startTimeUnixNano)).toBe(true);
        expect(BigInt(chat.endTimeUnixNano) <= BigInt(root.endTimeUnixNano)).toBe(true);
      }
    }
  });

  it('has as many tool spans and failures as the tools report counts', async () => {
    const traces = parseLines<OtlpTracesData>(await exportEvents({ format: 'otlp-traces' }));
    const toolsReport = JSON.parse(
      await captureStdout(() =>
        runToolsReport(
          { ...FIXTURE_OPTIONS, since: '2026-01-01', until: '2026-12-31', json: true },
          { now: NOW },
        ),
      ),
    ) as { data: { totals: { calls: number; errors: number } } };
    const toolSpans = traces
      .flatMap(spansOf)
      .filter((span) => span.name.startsWith('execute_tool '));
    const failed = toolSpans.filter((span) => span.status?.code === 2);

    expect(toolSpans.length).toBeGreaterThan(0);
    expect(toolSpans).toHaveLength(toolsReport.data.totals.calls);
    expect(failed).toHaveLength(toolsReport.data.totals.errors);
    expect(failed.map((span) => attribute(span, 'error.type'))).toEqual(failed.map(() => '_OTHER'));
  });

  it('leaves paths out unless --otel-include-paths is given', async () => {
    const pathKeys = ['llm_usage.repo_root', 'llm_usage.cwd', 'llm_usage.git_branch'];
    const keysOf = (output: string) =>
      new Set(
        parseLines<OtlpTracesData>(output)
          .flatMap(spansOf)
          .flatMap((span) => span.attributes.map((entry) => entry.key)),
      );

    const withoutPaths = keysOf(await exportEvents({ format: 'otlp-traces' }));
    const withPaths = keysOf(await exportEvents({ format: 'otlp-traces', otelIncludePaths: true }));

    expect(pathKeys.filter((key) => withoutPaths.has(key))).toEqual([]);
    expect(withPaths.has('llm_usage.repo_root')).toBe(true);
  });

  it('applies the source and date filters as jsonl does', async () => {
    const codexOnly = parseLines<OtlpTracesData>(
      await exportEvents({ format: 'otlp-traces', source: 'codex' }),
    );
    const beforeAll = await exportEvents({ format: 'otlp-traces', until: '2025-12-31' });

    expect(codexOnly.map((data) => data.resourceSpans[0].resource.attributes)).toEqual([
      [{ key: 'service.name', value: { stringValue: 'codex' } }],
    ]);
    expect(beforeAll).toBe('');
  });

  it('gives each usage event its own chat span id across windowed exports', async () => {
    const piOnly = { source: 'pi', piDir: path.resolve('tests/fixtures/e2e/pi') };
    const chatIds = async (options: EventsCommandOptions) =>
      parseLines<OtlpTracesData>(await exportEvents({ ...piOnly, ...options }))
        .flatMap(spansOf)
        .filter((span) => span.name.startsWith('chat'))
        .map((span) => span.spanId);

    const all = await chatIds({ format: 'otlp-traces' });
    const january = await chatIds({ format: 'otlp-traces', until: '2026-01-31' });
    const february = await chatIds({ format: 'otlp-traces', since: '2026-02-01' });

    expect(january).toHaveLength(1);
    expect(february).toHaveLength(1);
    expect(all).toEqual([...january, ...february]);
  });

  it('rejects --otel-include-paths without --format otlp-traces', async () => {
    await expect(runEventsReport({ format: 'jsonl', otelIncludePaths: true })).rejects.toThrow(
      '--otel-include-paths needs --format otlp-traces',
    );
  });
});
