import { loadDatabaseSync } from './sqlite-fixture-db.js';

export type OpenCodeMessageFixture = {
  id: string;
  sessionId: string;
  timeCreated: number;
  data: string;
};

/** The OpenCode rows of the multi-source e2e and the golden fixture catalogue. */
export const E2E_OPENCODE_MESSAGES: readonly OpenCodeMessageFixture[] = [
  {
    id: 'opencode-e2e-message-1',
    sessionId: 'opencode-e2e-session',
    timeCreated: Date.parse('2026-06-15T12:00:00.000Z'),
    data: JSON.stringify({
      role: 'assistant',
      providerID: 'openai',
      modelID: 'gpt-4.1-opencode',
      tokens: {
        input: 90,
        output: 40,
        reasoning: 0,
        cache: { read: 10, write: 0 },
        total: 140,
      },
    }),
  },
  {
    id: 'opencode-e2e-message-2',
    sessionId: 'opencode-e2e-session',
    timeCreated: Date.parse('2026-06-15T12:05:00.000Z'),
    data: JSON.stringify({
      role: 'assistant',
      providerID: 'openai',
      modelID: 'gpt-4.1-opencode',
      tokens: {
        input: 35,
        output: 20,
        reasoning: 0,
        cache: { read: 5, write: 0 },
        total: 60,
      },
    }),
  },
];

function openFixtureDb(dbPath: string) {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('OpenCode e2e fixtures require node:sqlite DatabaseSync support.');
  }

  return new DatabaseSync(dbPath);
}

function insertMessages(
  database: ReturnType<typeof openFixtureDb>,
  messages: readonly OpenCodeMessageFixture[],
): void {
  const insertMessage = database.prepare(
    'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
  );

  for (const message of messages) {
    insertMessage.run(message.id, message.sessionId, message.timeCreated, message.data);
  }
}

export function createOpenCodeFixtureDb(
  dbPath: string,
  messages: readonly OpenCodeMessageFixture[],
): void {
  const database = openFixtureDb(dbPath);

  try {
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE part (id TEXT PRIMARY KEY);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    insertMessages(database, messages);
  } finally {
    database.close();
  }
}

/** Adds rows to a database made by `createOpenCodeFixtureDb`, as OpenCode does while running. */
export function appendOpenCodeMessages(
  dbPath: string,
  messages: readonly OpenCodeMessageFixture[],
): void {
  const database = openFixtureDb(dbPath);

  try {
    insertMessages(database, messages);
  } finally {
    database.close();
  }
}
