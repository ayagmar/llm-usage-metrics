export { computeActiveMs, computeUnionActiveMs, IDLE_GAP_CAP_MS } from './domain/active-time.js';
export { normalizeTimestamp, type NumberLike } from './domain/normalization.js';
export {
  USAGE_EVENT_NORMALIZATION_VERSION,
  createUsageEvent,
  getEventSessionKey,
  normalizeSourceId,
  type CostMode,
  type SourceId,
  type UsageEvent,
  type UsageEventInput,
} from './domain/usage-event.js';
export {
  EVENT_KINDS,
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  isUsageRecord,
  type EventKind,
  type MessageEvent,
  type MessageEventInput,
  type SessionEvent,
  type SessionMetaEvent,
  type SessionMetaEventInput,
  type SessionMetaFields,
  type ToolCallEvent,
  type ToolCallEventInput,
  type ToolCallStatus,
  type UsageRecord,
  type UsageRecordInput,
} from './domain/session-event.js';
export { CORE_EVENT_VERSION, getParserVersion } from './sources/parse-fingerprint.js';
export type {
  ReadEventsOptions,
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceCapabilities,
  SourceParseFileDiagnostics,
  SourceReadDiagnostics,
  SourceReadOptions,
  SourceSkippedRowReasonStat,
} from './sources/source-adapter.js';
export { createReadDiagnostics, toParseDiagnostics } from './sources/parse-diagnostics.js';
export * from './sources/source-context.js';
export { collect, collectFile } from './stream/collect.js';
export { pipe, type Stage } from './stream/pipe.js';
export { readEvents } from './stream/read-events.js';
export type {
  JsonlReadCursor,
  ReadCursor,
  ReadResume,
  ReplacedEventCounts,
} from './stream/cursor.js';
export { kinds } from './stream/kinds.js';
export { since, until } from './stream/window.js';
export { bySession, type SessionGroup } from './stream/by-session.js';
export * from './dedup/content-hash.js';
export { dedupeRepeatedAcrossFiles, repeatedAcrossFiles } from './dedup/repeated-across-files.js';
export * from './dedup/copied-session.js';
export { dedupeToolCalls } from './dedup/tool-calls.js';
