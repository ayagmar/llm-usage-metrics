import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Keep in-process tests from writing fixture events into the user's real
    // events.db; tests that need the store on must set an explicit temp path.
    // Spawned CLIs inherit this env, so the cache root is redirected too: the
    // pricing and update caches must never land in the user's real cache dir, nor the
    // default ledger in the real data dir.
    env: {
      LLM_USAGE_EVENT_STORE: '0',
      LLM_USAGE_CONFIG_PATH: '/tmp/llm-usage-metrics-test-missing-config.toml',
      LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      XDG_CACHE_HOME: path.join(os.tmpdir(), 'llm-usage-metrics-test-cache'),
      XDG_DATA_HOME: path.join(os.tmpdir(), 'llm-usage-metrics-test-data'),
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/bin.ts',
        'src/cli/index.ts',
        'src/cli/report-definitions/report-definition-types.ts',
        'src/cli/usage-data-contracts.ts',
        'src/domain/usage-report-row.ts',
        'src/optimize/optimize-row.ts',
        'src/pricing/types.ts',
        'src/trends/trends-series.ts',
        'src/wrapped/wrapped-recap.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
    },
  },
});
