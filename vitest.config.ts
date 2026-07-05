import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
    },
  },
});
