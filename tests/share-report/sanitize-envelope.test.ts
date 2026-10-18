import { describe, expect, it } from 'vitest';

import { buildShareReportData } from '../../src/cli/build-share-report-data.js';
import { buildWrappedData } from '../../src/cli/build-wrapped-data.js';
import type { BuildUsageDataDeps } from '../../src/cli/usage-data-contracts.js';
import { parseReportJsonEnvelope } from '../../src/cli/share-report-artifact.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { renderWrappedReport } from '../../src/render/render-wrapped-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { createCorpusAdapters } from '../helpers/share-payload.js';

useIsolatedEnvironment();
useBundledPricingOnly();

const event = (repoRoot: string, timestamp: string): UsageEvent =>
  createUsageEvent({
    source: 'claude',
    sessionId: `session-${repoRoot}`,
    timestamp,
    repoRoot,
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
  });

// Dated folders and a folder named like a metric: their labels equal a month key and `tokens`.
const EVENTS = [
  event('/w/2026-10', '2026-10-05T12:00:00Z'),
  event('/w/tokens', '2026-09-10T12:00:00Z'),
];

const deps: BuildUsageDataDeps = {
  now: () => new Date('2026-10-16T12:00:00Z'),
  createAdapters: createCorpusAdapters(EVENTS),
  getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
};

describe('the wrapped envelope under --redact', () => {
  it('keeps every month, date and metric when projects are named like them', async () => {
    const options = { timezone: 'UTC', sync: false, pricingOffline: true, redact: true };
    const wrapped = await buildWrappedData(options, deps);
    const envelope = parseReportJsonEnvelope(renderWrappedReport(wrapped.recap, 'json'));
    const window = { since: '2026-01-01', until: '2026-12-31' };
    const data = await buildShareReportData(
      {
        command: 'wrapped',
        options,
        window,
        initialView: { ...window, granularity: 'week' },
        envelope,
      },
      deps,
    );

    expect(data.dictionaries.projects).toEqual(expect.arrayContaining(['project-1', 'project-2']));
    expect(JSON.stringify(envelope.data)).toContain('"month":"2026-10"');
    expect(data.envelope?.data).toEqual(envelope.data);
  });
});
