/**
 * Goldens of trends and compare --by-repo (trends-compare-repo.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M9_TC_GOLDEN_NAMES: readonly string[] = [
  'reports/trends-by-repo.json',
  'reports/compare-by-repo.json',
  'reports/compare-by-repo.txt',
];
