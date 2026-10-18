import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  ALL_SOURCE_IDS,
  captureStdout,
  createE2eSourceOptions,
  expectGolden,
  fixedNow,
  freezeDate,
  normalizePaths,
  type SourceOptions,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M13_OTLP_METRICS_GOLDEN_NAMES } from './m13-otlp-metrics-names.js';

const [metricsGolden, toolsGolden] = M13_OTLP_METRICS_GOLDEN_NAMES;

// The tools report's fixtures: real claude, codex and pi logs with tool calls and results.
const TOOL_FIXTURES = path.resolve('tests/fixtures/tools');

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `OTLP metrics goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useBundledPricingOnly();
    useGoldenUpdateCheck(M13_OTLP_METRICS_GOLDEN_NAMES);
    let e2eOptions: SourceOptions;

    beforeAll(async () => {
      freezeDate();
      e2eOptions = await createE2eSourceOptions(environment.rootDir);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it(`freezes ${metricsGolden}`, async () => {
      const output = await captureStdout(() =>
        runEventsReport(
          {
            ...e2eOptions,
            source: ALL_SOURCE_IDS.join(','),
            timezone: 'UTC',
            pricingOffline: true,
            format: 'otlp-metrics',
          },
          { now: fixedNow },
        ),
      );

      expect(output.length).toBeGreaterThan(0);
      await expectGolden(metricsGolden, normalizePaths(output, environment.rootDir));
    });

    it(`freezes ${toolsGolden}`, async () => {
      const output = await captureStdout(() =>
        runEventsReport(
          {
            claudeDir: path.join(TOOL_FIXTURES, 'claude'),
            codexDir: path.join(TOOL_FIXTURES, 'codex'),
            piDir: path.join(TOOL_FIXTURES, 'pi'),
            source: 'claude,codex,pi',
            timezone: 'UTC',
            pricingOffline: true,
            format: 'otlp-metrics',
          },
          { now: fixedNow },
        ),
      );

      expect(output).toContain('gen_ai.execute_tool.duration');
      await expectGolden(toolsGolden, normalizePaths(output, environment.rootDir));
    });
  },
);
