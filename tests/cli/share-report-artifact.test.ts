import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildShareReportArtifact } from '../../src/cli/share-report-artifact.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { setLogLevel } from '../../src/utils/logger.js';
import { createCorpusAdapters } from '../helpers/share-payload.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const WINDOW = { since: '2026-01-01', until: '2026-06-20' } as const;

function usage(sessionId: string, timestamp: string) {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp,
    model: 'claude-sonnet-4-5',
    inputTokens: 1_000,
    outputTokens: 100,
  });
}

describe('buildShareReportArtifact', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  afterEach(() => {
    setLogLevel('info');
    vi.restoreAllMocks();
  });

  it('says hourly detail was dropped when the file is written, also with --quiet', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lines = () => stderr.mock.calls.map((call) => String(call[0]));
    setLogLevel('warn');

    const artifact = await buildShareReportArtifact(
      {
        command: 'daily',
        options: { timezone: 'UTC', pricingOffline: true, cost: false },
        window: WINDOW,
        initialView: { ...WINDOW, granularity: 'day' },
        // Over any target: older cells roll up to days.
        targetBytes: 1,
        fileBaseName: 'usage-daily-share',
        logLabel: 'usage',
      },
      {
        now: () => new Date('2026-06-21T12:00:00.000Z'),
        createAdapters: createCorpusAdapters([
          usage('old', '2026-01-10T10:00:00.000Z'),
          usage('new', '2026-06-15T10:00:00.000Z'),
        ]),
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '',
          disabledBy: 'configuration',
        }),
      },
    );

    // After the command's own diagnostics, which print between building and writing.
    expect(lines().filter((line) => line.includes('hourly detail'))).toEqual([]);

    artifact.render();

    expect(lines().filter((line) => line.includes('hourly detail'))).toEqual([
      expect.stringContaining(
        'Share report: hourly detail from 2026-03-22; earlier usage is by day',
      ),
    ]);
  });
});
