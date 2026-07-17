export {
  closeEventStore,
  countEvents,
  deleteStoredFiles,
  getDefaultEventStorePath,
  getFileEntry,
  openEventStore,
  readDepartedFileEvents,
  readEventStoreStoredFiles,
  readEventStoreSummary,
  readFileEvents,
  replaceFileEvents,
  serializeEventStoreFingerprint,
  vacuumEventStore,
  type DeleteStoredFilesInput,
  type DeleteStoredFilesResult,
  type EventStoreDependencyFingerprint,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
  type EventStoreStoredFile,
  type EventStoreSummary,
  type ReplaceFileEventsInput,
} from './event-store-administration.js';
export { computeEventContentHash, normalizeStoredEvent } from './event-store-codec.js';
export { type EventStore, type LoadEventStoreSqliteModule } from './event-store-database.js';
export {
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreSchemaVersionError,
  MIGRATION_BATCH_SIZE,
  migrateSchemaV1ToV2,
  migrateSchemaV2ToV3,
} from './event-store-schema.js';
