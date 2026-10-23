export {
  claimOverrideOnlyFiles,
  closeEventStore,
  countEvents,
  countFileEvents,
  deleteStoredFiles,
  getDefaultEventStorePath,
  findLegacyEventStore,
  getLegacyEventStorePath,
  getFileEntry,
  getFileReadCursor,
  listStoredFileFingerprints,
  openEventStore,
  readDepartedFileEvents,
  readEventStoreEvents,
  readEventStoreMeta,
  readEventStoreMetaValues,
  readEventStoreStoredFiles,
  readEventStoreSummary,
  readFileEvents,
  readOverrideOnlyFiles,
  readStoredFileSessionIds,
  readStoredFileSnapshots,
  readStoredSessionEvents,
  replaceFileEvents,
  replaceFilesEvents,
  serializeEventStoreFingerprint,
  vacuumEventStore,
  writeEventStoreMeta,
  type DeleteStoredFilesInput,
  type DeleteStoredFilesResult,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
  type EventStoreFileSnapshot,
  type EventStoreStoredFile,
  type EventStoreSummary,
  type ReplaceFileEventsInput,
} from './event-store-administration.js';
export type { FileDependencyFingerprint as EventStoreDependencyFingerprint } from '@ayagmar/agent-sessions/internal';
export type { StoredSessionEvent, StoredSessionEventKind } from './event-store-session-events.js';
export type { EventStoreAppend } from './event-store-append.js';
export { normalizeStoredEvent } from './event-store-codec.js';
export { readGitRoots, recordGitRoots } from './event-store-git-roots.js';
export {
  runTransaction,
  type EventStore,
  type LoadEventStoreSqliteModule,
} from './event-store-database.js';
export {
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreSchemaVersionError,
  isSupportedSchemaVersion,
  MIGRATION_BATCH_SIZE,
  migrateSchemaV1ToV2,
  migrateSchemaV2ToV3,
  migrateSchemaV4ToV5,
} from './event-store-schema.js';
