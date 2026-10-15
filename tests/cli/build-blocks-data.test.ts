import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { buildBlocksData } from '../../src/cli/build-blocks-data.js';
import { buildBlocksReport } from '../../src/cli/run-blocks-report.js';
import type { BlocksCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

function event(timestamp: string, source = 'claude', model = 'claude-sonnet-4-5'): UsageEvent {
  return createUsageEvent({
    source,
    sessionId: 's',
    timestamp,
    provider: source === 'claude' ? 'anthropic' : 'openai',
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
