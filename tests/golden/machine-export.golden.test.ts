import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as PackageMetadataModule from '../../src/cli/package-metadata.js';
import { runMachineExport } from '../../src/cli/run-machine-export.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  expectGolden,
  FIXED_GOLDENS,
  fixedNow,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

// The bundle header carries the CLI version; pin it so a release does not move the golden.
vi.mock('../../src/cli/package-metadata.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PackageMetadataModule>()),
  loadPackageMetadataFromRuntime: () => ({
    packageName: 'llm-usage-metrics',
    packageVersion: '0.0.0-golden',
  }),
}));

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(
  `machine export golden (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useGoldenUpdateCheck();

    beforeAll(async () => {
      freezeDate();
      const configPath = path.join(environment.rootDir, 'config.toml');
      await writeFile(
        configPath,
        [
          'sources = ["pi", "codex"]',
          '[sourceDirs]',
          `pi = ${JSON.stringify(path.resolve('tests/fixtures/e2e/pi'))}`,
          `codex = ${JSON.stringify(path.resolve('tests/fixtures/e2e/codex'))}`,
          '',
        ].join('\n'),
      );
      vi.stubEnv('LLM_USAGE_CONFIG_PATH', configPath);
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(environment.rootDir, 'events.db'));
      // The header names the exporting host.
      vi.spyOn(os, 'hostname').mockReturnValue('golden-host');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
    });

    afterAll(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('freezes machines/export.jsonl', async () => {
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

      await runMachineExport({}, { stdout, now: fixedNow });
      const bundle = Buffer.concat(chunks).toString('utf8');

      expect(bundle).toContain('"hostname":"golden-host"');
      await expectGolden(FIXED_GOLDENS.machinesExport, normalizePaths(bundle, environment.rootDir));
    });
  },
);
