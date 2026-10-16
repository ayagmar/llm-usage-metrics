import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildShareReportData,
  type ShareReportRequest,
} from '../../src/cli/build-share-report-data.js';
import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import type { BuildUsageDataDeps } from '../../src/cli/usage-data-contracts.js';
import { renderReportJson } from '../../src/render/report-json.js';
import type { ShareReportData } from '../../src/share-report/types.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  FIXED_NOW,
  WINDOWS_SKIP_REASON,
} from '../golden/golden-harness.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';
import { createCorpusAdapters, generateShareCorpus } from '../helpers/share-payload.js';

const corpusDeps: BuildUsageDataDeps = {
  now: () => FIXED_NOW,
  createAdapters: createCorpusAdapters(generateShareCorpus(5, 120)),
  getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
};

const corpusRequest: ShareReportRequest = {
  command: 'daily',
  options: { timezone: 'Europe/Paris', pricingOffline: true },
  window: { since: '2026-03-15', until: '2026-06-20' },
  initialView: { since: '2026-06-14', until: '2026-06-20', granularity: 'day' },
};

describe('share payload matches report-share.v1.schema.json', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();
  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    validators = compileReportValidators();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  function validate(data: ShareReportData): ShareReportData {
    const output = renderReportJson('share', data);
    return (validateReportOutput(validators, 'share', output) as { data: ShareReportData }).data;
  }

  it('validates a corpus payload in every cost mode', async () => {
    const data = validate(await buildShareReportData(corpusRequest, corpusDeps));

    expect(data.cube.period.length).toBeGreaterThan(0);
    expect(data.sessions.rows.length).toBeGreaterThan(0);
    expect(data.blocks.rows.length).toBeGreaterThan(0);
    expect(Object.keys(data.cube.costs)).toEqual(['explicit', 'estimated', 'both']);
  });

  it('validates --no-cost, --redact and a payload rolled up to days', async () => {
    const noCost = validate(
      await buildShareReportData(
        { ...corpusRequest, options: { ...corpusRequest.options, cost: false, redact: true } },
        corpusDeps,
      ),
    );
    const rolledUp = validate(
      await buildShareReportData({ ...corpusRequest, targetBytes: 1 }, corpusDeps),
    );

    expect(noCost.meta).toMatchObject({ costMode: null, redacted: true });
    expect(rolledUp.meta.hourlyFrom).toBe('2026-03-22');
    expect(rolledUp.dictionaries.periods[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('validates a payload whose estimated modes did not price', async () => {
    const data = validate(
      await buildShareReportData(
        { ...corpusRequest, options: { ...corpusRequest.options, costMode: 'explicit' } },
        { ...corpusDeps, resolvePricingSource: () => Promise.reject(new Error('no prices')) },
      ),
    );

    expect(data.meta.unavailableCostModes).toEqual(['estimated', 'both']);
  });

  it('validates an empty window', async () => {
    const data = validate(
      await buildShareReportData(
        { ...corpusRequest, window: { since: '2027-01-01', until: '2027-01-31' } },
        corpusDeps,
      ),
    );

    expect(data.cube.period).toEqual([]);
    expect(data.blocks.rows).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')(`golden fixture (${WINDOWS_SKIP_REASON})`, () => {
    it('validates a compare window with an embedded compare --by-repo envelope', async () => {
      const options = {
        ...(await createE2eSourceOptions(environment.rootDir)),
        source: ALL_SOURCE_IDS.join(','),
        timezone: 'UTC',
        pricingOffline: true,
      };
      const compare = JSON.parse(
        await buildCompareReport({
          ...options,
          since: '2026-06-01',
          until: '2026-06-30',
          vsSince: '2026-05-01',
          vsUntil: '2026-05-31',
          byRepo: true,
          json: true,
        }),
      ) as { data: Record<string, unknown> };
      const data = validate(
        await buildShareReportData(
          {
            command: 'compare',
            options: { ...options, redact: true },
            window: { since: '2026-05-01', until: '2026-06-30' },
            initialView: { since: '2026-06-01', until: '2026-06-30', granularity: 'day' },
            envelope: { report: 'compare', data: compare.data },
          },
          { now: () => FIXED_NOW },
        ),
      );

      expect(data.envelope?.report).toBe('compare');
      expect(data.envelope?.data.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ project: 'project-1' })]),
      );
      expect(JSON.stringify(data.envelope)).not.toContain('repoRoot');
    });
  });
});
