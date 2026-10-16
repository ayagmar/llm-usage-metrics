import type { SourceAdapter } from '@ayagmar/agent-sessions';
import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildBlocksReport } from '../../src/cli/run-blocks-report.js';
import type { BlocksCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { PROJECT_FIXTURE_EVENTS } from '../golden/m9-project-fixture.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

/** An active block whose model has no price, so its cost and burn rate are incomplete. */
const UNPRICED_ACTIVE: UsageEvent = createUsageEvent({
  source: 'claude',
  sessionId: 'unpriced',
  timestamp: '2026-06-21T11:00:00.000Z',
  provider: 'anthropic',
  model: 'unpriced-model-for-schema-test',
  inputTokens: 100,
  outputTokens: 10,
});

const PRICED_ACTIVE: UsageEvent = createUsageEvent({
  source: 'claude',
  sessionId: 'priced',
  timestamp: '2026-06-21T11:30:00.000Z',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  inputTokens: 100,
  outputTokens: 10,
});

function adapters(events: readonly UsageEvent[]): () => SourceAdapter[] {
  return () =>
    ['claude', 'codex'].map((source) => ({
      id: source,
      discoverFiles: async () => [`/blocks-schema/${source}.jsonl`],
      read: readFrom(async () => events.filter((event) => event.source === source)),
    }));
}

describe('blocks --json matches report-blocks.v1.schema.json', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    validators = compileReportValidators();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  async function validateBlocks(
    events: readonly UsageEvent[],
    options: BlocksCommandOptions = {},
  ): Promise<{ data: Record<string, unknown> }> {
    const output = await buildBlocksReport(
      { timezone: 'UTC', pricingOffline: true, json: true, ...options },
      {
        now: () => NOW,
        createAdapters: adapters(events),
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '',
          disabledBy: 'configuration',
        }),
      },
    );

    return validateReportOutput(validators, 'blocks', output) as { data: Record<string, unknown> };
  }

  it('validates the default window, --top, --all, and an empty report', async () => {
    const events = [...PROJECT_FIXTURE_EVENTS, PRICED_ACTIVE];

    expect((await validateBlocks(events)).data.blockCount).toBeGreaterThan(0);
    expect((await validateBlocks(events, { top: '2' })).data.top).toEqual({
      count: 2,
      rankedBy: 'cost',
    });
    expect((await validateBlocks(events, { all: true })).data.since).toBeNull();
    expect((await validateBlocks([])).data.blocks).toEqual([]);
  });

  it('validates an active block with an incomplete cost', async () => {
    const { data } = await validateBlocks([UNPRICED_ACTIVE, PRICED_ACTIVE]);

    expect(data.activeBlocks).toMatchObject([
      { costIncomplete: true, active: { costIncomplete: true, remainingMinutes: 240 } },
    ]);
  });

  it('rejects a payload with an unknown field', () => {
    const validate = validators.get('blocks');
    const payload = {
      schemaVersion: 1,
      report: 'blocks',
      data: {
        estimated: true,
        blockHours: 5,
        timezone: 'UTC',
        since: null,
        until: null,
        top: null,
        blockCount: 0,
        blocks: [],
        activeBlocks: [],
        extra: 1,
      },
    };

    expect(validate?.(payload)).toBe(false);
  });
});
