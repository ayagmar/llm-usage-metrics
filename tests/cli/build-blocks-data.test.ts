import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { describe, expect, it, vi } from 'vitest';

import { buildBlocksData } from '../../src/cli/build-blocks-data.js';
import { buildBlocksReport } from '../../src/cli/run-blocks-report.js';
import type { BlocksCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

function event(
  timestamp: string,
  source = 'claude',
  model = 'claude-sonnet-4-5',
  repoRoot?: string,
  provider = source === 'claude' ? 'anthropic' : 'openai',
): UsageEvent {
  return createUsageEvent({
    source,
    sessionId: 's',
    timestamp,
    repoRoot,
    provider,
    model,
    inputTokens: 1_000,
    outputTokens: 100,
  });
}

function adaptersFor(events: readonly UsageEvent[]): () => SourceAdapter[] {
  return () =>
    ['claude', 'codex'].map((source) => ({
      id: source,
      discoverFiles: async () => [`/blocks-test/${source}.jsonl`],
      read: readFrom(async () => events.filter((candidate) => candidate.source === source)),
    }));
}

function build(events: readonly UsageEvent[], options: BlocksCommandOptions = {}) {
  return buildBlocksData(
    { timezone: 'UTC', pricingOffline: true, ...options },
    {
      now: () => NOW,
      createAdapters: adaptersFor(events),
      getEventStoreRuntimeConfig: () => ({
        enabled: false,
        path: '',
        disabledBy: 'configuration',
      }),
    },
  );
}

describe('buildBlocksData', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  it('reports the last 7 days by default, reading a week earlier for the chain start', async () => {
    const result = await build([
      // Before the lookback: never read, so it cannot shift anything.
      event('2026-06-07T23:30:00.000Z'),
      // In the lookback, running into since (2026-06-15): kept with its earlier event.
      event('2026-06-14T22:30:00.000Z'),
      event('2026-06-15T01:00:00.000Z'),
      // In the lookback, ending before since: dropped.
      event('2026-06-10T09:00:00.000Z'),
    ]);

    expect(result.defaultWindowSince).toBe('2026-06-15');
    expect(result.data).toMatchObject({ since: '2026-06-15', until: null, blockCount: 1 });
    expect(result.data.blocks.map((block) => [block.start, block.eventCount])).toEqual([
      ['2026-06-14T22:00:00.000Z', 2],
    ]);
  });

  it('marks a block in progress at now active, with its burn rate', async () => {
    const result = await build([event('2026-06-21T10:15:00.000Z')]);

    expect(result.data.activeBlocks).toHaveLength(1);
    expect(result.data.blocks[0]?.active).toMatchObject({
      remainingMinutes: 180,
      tokensPerHour: 550,
    });
  });

  it('has no active block when --until is in the past, even one still running', async () => {
    // UTC+14: now is 02:00 on 2026-06-22 there, so 2026-06-21 has ended, but the block of
    // its 22:30 event runs from 08:00 to 13:00 UTC, past now (12:00 UTC).
    const result = await build([event('2026-06-21T08:30:00.000Z')], {
      since: '2026-06-21',
      until: '2026-06-21',
      timezone: 'Pacific/Kiritimati',
    });

    expect(result.data.blocks).toHaveLength(1);
    expect(result.data.activeBlocks).toEqual([]);
    expect(result.data.blocks[0]?.active).toBeNull();
  });

  it('covers the last N days with --last and the full history with --all', async () => {
    const events = [event('2026-05-01T10:00:00.000Z'), event('2026-06-20T10:00:00.000Z')];

    expect((await build(events, { last: '2' })).data).toMatchObject({
      since: '2026-06-20',
      until: '2026-06-21',
      blockCount: 1,
    });

    const all = await build(events, { all: true });
    expect(all.data).toMatchObject({ since: null, until: null, blockCount: 2 });
    expect(all.defaultWindowSince).toBeUndefined();
    expect(all.data.blocks.every((block) => !block.startUncertain)).toBe(true);
  });

  it('ranks --top by tokens with --no-cost and keeps active blocks listed', async () => {
    const events = [
      event('2026-06-20T01:00:00.000Z'),
      event('2026-06-20T01:30:00.000Z'),
      event('2026-06-21T10:00:00.000Z', 'codex', 'gpt-5'),
    ];
    const result = await build(events, { top: '1', cost: false });

    expect(result.data.top).toEqual({ count: 1, rankedBy: 'tokens' });
    expect(result.data.blockCount).toBe(2);
    expect(result.data.blocks.map((block) => block.start)).toEqual(['2026-06-20T01:00:00.000Z']);
    expect(result.data.activeBlocks.map((block) => block.source)).toEqual(['codex']);
  });

  it('never loads pricing with --no-cost', async () => {
    const resolvePricingSource = vi.fn(() => {
      throw new Error('pricing should not be loaded with --no-cost');
    });
    const result = await buildBlocksData(
      { timezone: 'UTC', cost: false },
      {
        now: () => NOW,
        createAdapters: adaptersFor([event('2026-06-20T01:00:00.000Z')]),
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '',
          disabledBy: 'configuration',
        }),
        resolvePricingSource,
      },
    );

    expect(resolvePricingSource).not.toHaveBeenCalled();
    expect(result.data.blockCount).toBe(1);
    expect(result.diagnostics.pricingOrigin).toBe('none');
  });

  it.each([
    ['--model', { model: 'claude-sonnet-4-5' }],
    ['--repo', { repo: 'api' }],
    ['--provider', { provider: 'anthropic' }],
  ] satisfies [string, BlocksCommandOptions][])(
    'keeps the account window when %s narrows the events',
    async (_flag, options) => {
      const events = [
        // Starts the block the selected event falls in, though it is not selected.
        event('2026-06-21T08:30:00.000Z', 'claude', 'claude-opus-4-1', '/w/web', 'openrouter'),
        event('2026-06-21T10:15:00.000Z', 'claude', 'claude-sonnet-4-5', '/w/api'),
        event('2026-06-21T09:00:00.000Z', 'codex', 'gpt-5', '/w/web'),
      ];
      const result = await build(events, options);

      expect(result.data.blockCount).toBe(1);
      expect(result.data.blocks[0]).toMatchObject({
        source: 'claude',
        start: '2026-06-21T08:00:00.000Z',
        startUncertain: false,
        eventCount: 1,
        totalTokens: 1_100,
        models: ['claude-sonnet-4-5'],
        // 60 min left of the 08:00 block; 1,100 tokens over the 4 h since it started.
        active: { remainingMinutes: 60, tokensPerHour: 275 },
      });
    },
  );

  it('reads the dataset once for --machine local when no other machine is configured', async () => {
    let reads = 0;
    const createAdapters = adaptersFor([event('2026-06-21T10:15:00.000Z')]);
    const result = await buildBlocksData(
      { timezone: 'UTC', pricingOffline: true, machine: 'local' },
      {
        now: () => NOW,
        createAdapters: () => {
          reads += 1;
          return createAdapters();
        },
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '',
          disabledBy: 'configuration',
        }),
      },
    );

    expect(result.data.blocks.map((block) => block.eventCount)).toEqual([1]);
    expect(reads).toBe(1);
  });

  it('leaves the blocks of unfiltered runs alone', async () => {
    const events = [
      event('2026-06-21T08:30:00.000Z', 'claude', 'claude-opus-4-1'),
      event('2026-06-21T10:15:00.000Z'),
    ];

    expect((await build(events)).data.blocks.map((block) => block.eventCount)).toEqual([2]);
  });

  it('rejects invalid and conflicting window flags', async () => {
    await expect(build([], { top: '0' })).rejects.toThrow('--top must be a positive integer');
    await expect(build([], { top: '2x' })).rejects.toThrow('--top must be a positive integer');
    await expect(build([], { last: '0' })).rejects.toThrow('--last must be a whole number');
    await expect(build([], { last: '3', since: '2026-06-01' })).rejects.toThrow(
      '--last cannot be combined',
    );
    await expect(build([], { all: true, until: '2026-06-01' })).rejects.toThrow(
      '--all cannot be combined',
    );
    await expect(build([], { since: '2026-6-1' })).rejects.toThrow();
  });

  it('refuses table-only flags with --json', async () => {
    await expect(buildBlocksReport({ json: true, compact: true })).rejects.toThrow(
      '--compact applies to terminal and markdown tables',
    );
    await expect(buildBlocksReport({ json: true, cost: false })).rejects.toThrow(
      '--no-cost applies to terminal and markdown tables',
    );
  });
});
