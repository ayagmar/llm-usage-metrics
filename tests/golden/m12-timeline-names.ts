/**
 * Goldens of `session --timeline` (session-timeline.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M12_TIMELINE_GOLDEN_NAMES: readonly string[] = [
  'reports/session-timeline-claude.json',
  'reports/session-timeline-claude.md',
  'reports/session-timeline-claude.txt',
  'reports/session-timeline-codex.txt',
  'reports/session-timeline-narrow.txt',
];
