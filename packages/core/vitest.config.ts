import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src');

export default defineConfig({
  // Examples import the package by name; resolve it to the sources, not dist.
  resolve: {
    alias: [
      { find: /^@ayagmar\/agent-sessions$/u, replacement: path.join(srcRoot, 'index.ts') },
      {
        find: /^@ayagmar\/agent-sessions\/(.+)$/u,
        replacement: path.join(srcRoot, '$1', 'index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Windows CI runners are several times slower at SQLite and child-process work; the
    // defaults (5 s per test, 10 s per hook) time out tests that pass everywhere else.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
    // Same isolation as the root config: no core test may read or write the host's
    // cache, data or config, even through code that later moves here from the CLI.
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
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
    },
  },
});
