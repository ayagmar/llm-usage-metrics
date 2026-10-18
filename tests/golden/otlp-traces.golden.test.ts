import path from 'node:path';

import { afterAll, beforeAll, describe, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  captureStdout,
  expectGolden,
  fixedNow,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M13_OTLP_TRACES_GOLDEN_NAMES } from './m13-otlp-traces-names.js';

const [tracesGolden, includePathsGolden] = M13_OTLP_TRACES_GOLDEN_NAMES;

// The tools report's fixtures: real claude, codex and pi logs with tool calls and turns.
const FIXTURES = path.resolve('tests/fixtures/tools');

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `OTLP traces goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useBundledPricingOnly();
    useGoldenUpdateCheck(M13_OTLP_TRACES_GOLDEN_NAMES);

    beforeAll(() => {
      freezeDate();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    async function exportTraces(options: EventsCommandOptions = {}): Promise<string> {
      const output = await captureStdout(() =>
        runEventsReport(
          {
            claudeDir: path.join(FIXTURES, 'claude'),
            codexDir: path.join(FIXTURES, 'codex'),
            piDir: path.join(FIXTURES, 'pi'),
            source: 'claude,codex,pi',
            timezone: 'UTC',
            pricingOffline: true,
            format: 'otlp-traces',
            ...options,
          },
          { now: fixedNow },
        ),
      );
      return normalizePaths(output, environment.rootDir);
    }

    it(`freezes ${tracesGolden}`, async () => {
      await expectGolden(tracesGolden, await exportTraces());
    });

    it(`freezes ${includePathsGolden}`, async () => {
      await expectGolden(includePathsGolden, await exportTraces({ otelIncludePaths: true }));
    });
  },
);
