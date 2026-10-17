/**
 * Goldens of the tools report (tools.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M12_TOOLS_GOLDEN_NAMES: readonly string[] = [
  'reports/tools.json',
  'reports/tools.md',
  'reports/tools.txt',
  'reports/tools-by-source-by-repo.txt',
  'reports/tools-narrow.txt',
  'reports/tools-empty.txt',
  'reports/tools-empty.md',
];
