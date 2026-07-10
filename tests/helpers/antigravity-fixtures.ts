import { createRequire } from 'node:module';

import { withSuppressedSqliteExperimentalWarning } from '../../src/sources/opencode/sqlite-warning-suppression.js';

type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
};

export type AntigravityTimestampFixture = {
  seconds: number;
  nanos?: number;
};

export type AntigravityUsageFixture = {
  fixedInputTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  responseId?: string;
};

export type AntigravityTurnFixture = {
  model?: string;
  timestamp?: AntigravityTimestampFixture;
  usage?: AntigravityUsageFixture;
  rawBlob?: Uint8Array;
};

export type AntigravityDbFixture = {
  turns?: AntigravityTurnFixture[];
  sessionCreatedAt?: AntigravityTimestampFixture;
  createGenMetadataTable?: boolean;
};

const require = createRequire(import.meta.url);

export function loadAntigravityFixtureDatabaseSync(): FixtureDatabaseSync | undefined {
  let sqliteModule: unknown;

  try {
    sqliteModule = withSuppressedSqliteExperimentalWarning(() => require('node:sqlite') as unknown);
  } catch {
    return undefined;
  }

  const moduleRecord = sqliteModule as { DatabaseSync?: unknown } | undefined;

  if (typeof moduleRecord?.DatabaseSync !== 'function') {
    return undefined;
  }

  return moduleRecord.DatabaseSync as FixtureDatabaseSync;
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remainingValue = BigInt(value);

  do {
    const nextByte = Number(remainingValue & 0x7fn);
    remainingValue /= 128n;
    bytes.push(remainingValue === 0n ? nextByte : nextByte | 0x80);
  } while (remainingValue > 0n);

  return bytes;
}

function encodeFieldKey(fieldNumber: number, wireType: number): number[] {
  return encodeVarint(fieldNumber * 8 + wireType);
}

function encodeVarintField(fieldNumber: number, value: number | undefined): number[] {
  if (value === undefined) {
    return [];
  }

  return [...encodeFieldKey(fieldNumber, 0), ...encodeVarint(value)];
}

function encodeLengthDelimitedField(fieldNumber: number, value: number[]): number[] {
  return [...encodeFieldKey(fieldNumber, 2), ...encodeVarint(value.length), ...value];
}

function encodeStringField(fieldNumber: number, value: string | undefined): number[] {
  if (value === undefined) {
    return [];
  }

  return encodeLengthDelimitedField(fieldNumber, [...new TextEncoder().encode(value)]);
}

function encodeTimestamp(timestamp: AntigravityTimestampFixture): number[] {
  return [...encodeVarintField(1, timestamp.seconds), ...encodeVarintField(2, timestamp.nanos)];
}

function encodeUsage(usage: AntigravityUsageFixture): number[] {
  return [
    ...encodeVarintField(1, usage.fixedInputTokens),
    ...encodeVarintField(2, usage.inputTokens),
    ...encodeVarintField(5, usage.cacheReadTokens),
    ...encodeVarintField(9, usage.outputTokens),
    ...encodeVarintField(10, usage.reasoningTokens),
    ...encodeStringField(11, usage.responseId),
  ];
}

export function encodeAntigravityGenMetadataBlob(turn: AntigravityTurnFixture): Uint8Array {
  if (turn.rawBlob) {
    return turn.rawBlob;
  }

  const timestampWrapper = turn.timestamp
    ? encodeLengthDelimitedField(4, encodeTimestamp(turn.timestamp))
    : [];
  const chatModel = [
    ...encodeStringField(19, turn.model),
    ...(turn.usage ? encodeLengthDelimitedField(4, encodeUsage(turn.usage)) : []),
    ...(timestampWrapper.length > 0 ? encodeLengthDelimitedField(9, timestampWrapper) : []),
  ];

  return new Uint8Array(encodeLengthDelimitedField(1, chatModel));
}

function encodeTrajectoryMetadataBlob(timestamp: AntigravityTimestampFixture): Uint8Array {
  return new Uint8Array(encodeLengthDelimitedField(2, encodeTimestamp(timestamp)));
}

export function createAntigravityFixtureDb(dbPath: string, fixture: AntigravityDbFixture): void {
  const DatabaseSync = loadAntigravityFixtureDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('Antigravity fixtures require node:sqlite DatabaseSync support.');
  }

  const database = new DatabaseSync(dbPath);

  try {
    if (fixture.createGenMetadataTable ?? true) {
      database.exec(`
        CREATE TABLE gen_metadata (
          idx INTEGER PRIMARY KEY,
          data BLOB
        );
      `);

      const insertMetadata = database.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');

      for (const [index, turn] of (fixture.turns ?? []).entries()) {
        insertMetadata.run(index, encodeAntigravityGenMetadataBlob(turn));
      }
    }

    if (fixture.sessionCreatedAt) {
      database.exec('CREATE TABLE trajectory_metadata_blob (data BLOB);');
      database
        .prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)')
        .run(encodeTrajectoryMetadataBlob(fixture.sessionCreatedAt));
    }
  } finally {
    database.close();
  }
}
