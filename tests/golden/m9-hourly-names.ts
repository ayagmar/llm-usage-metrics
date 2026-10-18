/**
 * Goldens of the hourly report (usage-hourly.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M9_HOURLY_GOLDEN_NAMES: readonly string[] = [
  'reports/usage-hourly.json',
  'reports/usage-hourly.md',
  'reports/usage-hourly.txt',
];
