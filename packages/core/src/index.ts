export * from './domain/active-time.js';
export * from './domain/normalization.js';
export * from './domain/provider-normalization.js';
export * from './domain/usage-event.js';
export {
  CORE_EVENT_VERSION,
  getParseFileFingerprint,
  getParserVersion,
  type EventStoreDependencyFingerprint,
  type EventStoreFileFingerprint,
} from './sources/parse-fingerprint.js';
export * from './sources/source-adapter.js';
export * from './sources/source-context.js';
export { collect, collectFile } from './stream/collect.js';
export { pipe, type Stage } from './stream/pipe.js';
export * from './dedup/content-hash.js';
export { dedupeRepeatedAcrossFiles, repeatedAcrossFiles } from './dedup/repeated-across-files.js';
export * from './dedup/copied-session.js';
