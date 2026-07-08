import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Keep in-process tests from writing fixture events into the user's real
    // events.db; tests that need the store on must set an explicit temp path.
    env: {
      LLM_USAGE_EVENT_STORE: '0',
      LLM_USAGE_CONFIG_PATH: '/tmp/llm-usage-metrics-test-missing-config.json',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
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
