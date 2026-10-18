import path from 'node:path';

import { afterAll, beforeAll, describe, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  createOpenCodeV2FixtureDb,
  E2E_OPENCODE_V2_MESSAGES,
  E2E_OPENCODE_V2_SESSIONS,
} from '../helpers/opencode-fixtures.js';
import {
  captureStdout,
  expectGolden,
  fixedNow,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M13_OC_GOLDEN_NAMES } from './m13-oc-names.js';

const [opencodeV2Events] = M13_OC_GOLDEN_NAMES;

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `OpenCode V2 goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useBundledPricingOnly();
    useGoldenUpdateCheck(M13_OC_GOLDEN_NAMES);

    beforeAll(() => {
      freezeDate();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it(`freezes ${opencodeV2Events}`, async () => {
      const dbPath = path.join(environment.rootDir, 'opencode.db');
      createOpenCodeV2FixtureDb(dbPath, E2E_OPENCODE_V2_SESSIONS, E2E_OPENCODE_V2_MESSAGES);

      const output = await captureStdout(() =>
        runEventsReport(
          {
            opencodeDb: dbPath,
            source: 'opencode',
            format: 'jsonl',
            timezone: 'UTC',
            pricingOffline: true,
          },
          { now: fixedNow },
        ),
      );

      await expectGolden(opencodeV2Events, normalizePaths(output, environment.rootDir));
    });
  },
);
