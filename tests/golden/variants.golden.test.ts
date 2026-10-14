import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildStatusline } from '../../src/cli/run-statusline.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  expectGolden,
  FIXED_GOLDENS,
  fixedNow,
  freezeDate,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `report variant goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    const pricing = useBundledPricingOnly();
    useGoldenUpdateCheck([FIXED_GOLDENS.variantsStatuslineAllSources]);
    let sources: SourceOptions & { source: string; timezone: 'UTC' };

    beforeAll(async () => {
      freezeDate();
      sources = {
        ...(await createE2eSourceOptions(environment.rootDir)),
        source: ALL_SOURCE_IDS.join(','),
        timezone: 'UTC',
      };
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('freezes variants/statusline-all-sources.txt', async () => {
      const output = `${await buildStatusline(sources, { now: fixedNow })}\n`;

      await expectGolden(
        FIXED_GOLDENS.variantsStatuslineAllSources,
        normalizePaths(output, environment.rootDir),
      );
    });

    it('never reaches the network', () => {
      expect(pricing.fetch).not.toHaveBeenCalled();
    });
  },
);
