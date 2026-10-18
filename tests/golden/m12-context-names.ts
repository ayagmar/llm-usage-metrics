/**
 * Goldens of the context report (context.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M12_CONTEXT_GOLDEN_NAMES: readonly string[] = [
  'reports/context.json',
  'reports/context.md',
  'reports/context.txt',
  'reports/context-by-session.json',
  'reports/context-by-session.txt',
  'reports/context-all.json',
  'reports/context-narrow.txt',
  'reports/context-empty.txt',
];
