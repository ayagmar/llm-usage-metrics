/**
 * Goldens of the OTLP traces export (otlp-traces.golden.test.ts).
 * That test passes this list to `useGoldenUpdateCheck`; `listExpectedGoldenNames` includes it.
 */
export const M13_OTLP_TRACES_GOLDEN_NAMES: readonly string[] = [
  'events/otlp-traces.jsonl',
  'events/otlp-traces-include-paths.jsonl',
];
