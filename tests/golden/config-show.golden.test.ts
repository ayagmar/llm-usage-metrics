import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, it, vi } from 'vitest';

import { runConfigShow } from '../../src/cli/create-config-command.js';
import type { ConfigShowCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { DEFAULT_LITELLM_PRICING_URL } from '@ayagmar/agent-sessions/pricing';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  captureStdout,
  expectGolden,
  FIXED_NOW,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M12_CONFIG_SHOW_GOLDEN_NAMES } from './m12-config-show-names.js';

const [jsonGolden, terminalGolden] = M12_CONFIG_SHOW_GOLDEN_NAMES;

// Skipped on Windows: default source paths differ there.
describe.skipIf(process.platform === 'win32')(
  `config show goldens (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useGoldenUpdateCheck(M12_CONFIG_SHOW_GOLDEN_NAMES);
    let options: ConfigShowCommandOptions;

    // One run touches every origin: flag (codex, overrides), env var (gemini), config (the
    // rest it sets) and default.
    beforeAll(async () => {
      freezeDate();
      const root = environment.rootDir;
      const configPath = path.join(root, 'config.toml');
      const cacheDir = path.join(root, 'cache', 'llm-usage-metrics');
      await mkdir(path.join(root, 'codex'));
      await mkdir(path.join(root, 'claude'));
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        path.join(cacheDir, 'litellm-pricing-cache.json'),
        JSON.stringify({
          formatVersion: 3,
          fetchedAt: FIXED_NOW.getTime() - 3 * 3_600_000,
          sourceUrl: DEFAULT_LITELLM_PRICING_URL,
          pricingByModel: { 'test-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 } },
        }),
      );
      await writeFile(
        configPath,
        [
          'sources = ["claude", "codex", "gemini", "pi"]',
          'parseWorkers = 2',
          '',
          '[sourceDirs]',
          `claude = ${JSON.stringify(path.join(root, 'claude'))}`,
          '',
          '[eventStore]',
          `path = ${JSON.stringify(path.join(root, 'store', 'events.db'))}`,
          '',
          '[machines.laptop]',
          'ssh = "me@laptop.local"',
          '',
          '[machines.old-desktop]',
          'ssh = "me@desktop.local"',
          'enabled = false',
          '',
        ].join('\n'),
      );
      vi.stubEnv('LLM_USAGE_CONFIG_PATH', configPath);
      vi.stubEnv('LLM_USAGE_EVENT_STORE', undefined);
      vi.stubEnv('XDG_CACHE_HOME', path.join(root, 'cache'));
      vi.stubEnv('GEMINI_CLI_HOME', path.join(root, 'gemini'));
      options = {
        codexDir: path.join(root, 'codex'),
        pricingOverrides: path.join(root, 'overrides.json'),
      };
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it(`freezes ${terminalGolden}`, async () => {
      const output = await captureStdout(() =>
        runConfigShow(options, { now: () => FIXED_NOW.getTime() }),
      );
      await expectGolden(terminalGolden, normalizePaths(output, environment.rootDir));
    });

    it(`freezes ${jsonGolden}`, async () => {
      const output = await captureStdout(() => runConfigShow({ ...options, json: true }));
      await expectGolden(jsonGolden, normalizePaths(output, environment.rootDir));
    });
  },
);
