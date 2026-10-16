/**
 * Goldens of the usage --by-repo and --repo reports (usage-repo.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M9_USAGE_GOLDEN_NAMES: readonly string[] = [
  'reports/usage-daily-by-repo.json',
  'reports/usage-daily-by-repo.txt',
  'reports/usage-monthly-repo-filter.json',
];
