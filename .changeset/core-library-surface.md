---
'@ayagmar/agent-sessions': minor
---

Define the 0.x library surface of `@ayagmar/agent-sessions`.

The public subpaths are `.`, `./registry` and `./sources/<id>`. `./otel` is experimental and
`./internal` has no stability promise. Names tagged `@internal` fall outside semver.

Added:

- `since`, `until` and `bySession` stages on `.`, and `readSources` on `./registry`.
- A resumable JSONL read cursor (`ReadResume`, `ReadCursor`, `JsonlReadCursor`); qwen reads
  resume from it.
- `./otel`: helpers that map events to OpenTelemetry GenAI attributes. They never emit
  message text, and paths and the git branch only with `includePaths: true`.

Breaking:

- The CLI-shaped helpers move from `.` to `./internal`: provider normalization, the terminal
  text helpers, `normalizeNonNegativeInteger`, `normalizeUsdCost`, `normalizeOptionalModel`,
  `BillableTokenUsage`, `hasBillableTokenBuckets`, `isPriceableEvent`, `getRepeatingSourceIds`,
  `getSessionCopyingSourceIds` and the parse fingerprint.
- The parse fingerprint is renamed: `EventStoreFileFingerprint` to `FileFingerprint`,
  `EventStoreDependencyFingerprint` to `FileDependencyFingerprint` and `getParseFileFingerprint`
  to `getFileFingerprint`. The serialized form is unchanged.
- `createReadDiagnostics` and `toParseDiagnostics` move from `./internal` to `.`.
- `SourceId` is `string`.
- `SourceCapabilities.sqlite` is removed; nothing read it.
- `./sources/cline` no longer exports the task-root helpers or `ClineFamilySourceId`.
- `canParseSourceOnWorker`, `createWorkerParseAdapter`, `sourceSupportsDirectories`,
  `LEGACY_CODEX_MODEL_FALLBACK` and the adapter options-type seams are tagged `@internal`.
