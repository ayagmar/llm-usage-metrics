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

export type OpenCodeV2SessionFixture = {
  id: string;
  directory: string;
  timeCreated: number;
};

export type OpenCodeV2MessageFixture = {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  timeCreated: number;
  data: string;
};

const V2_SESSION_ID = 'opencode-v2-e2e-session';
const V2_STEP_ONE_TIME = Date.parse('2026-06-16T09:00:00.000Z');

function v2AssistantStep(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cost: number;
}): string {
  return JSON.stringify({
    agent: 'build',
    model: { id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'default' },
    content: [{ type: 'text', text: 'synthetic reply' }],
    finish: 'tool-calls',
    cost: tokens.cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cacheRead, write: 0 },
    },
    time: { created: 0, completed: 0 },
  });
}

/** One synthetic OpenCode V2 session, shaped like a v2.0.32 `opencode.db`. */
export const E2E_OPENCODE_V2_SESSIONS: readonly OpenCodeV2SessionFixture[] = [
  { id: V2_SESSION_ID, directory: '/workspace/opencode-v2-repo', timeCreated: V2_STEP_ONE_TIME },
];

/**
 * A user turn, two assistant steps (the first with more reasoning than visible output, as
 * V2 stores them), a step that failed before reporting usage, and an idle marker.
 */
export const E2E_OPENCODE_V2_MESSAGES: readonly OpenCodeV2MessageFixture[] = [
  {
    id: 'opencode-v2-e2e-user-1',
    sessionId: V2_SESSION_ID,
    type: 'user',
    seq: 0,
    timeCreated: V2_STEP_ONE_TIME - 1_000,
    data: JSON.stringify({ text: 'synthetic prompt', time: { created: 0 } }),
  },
  {
    id: 'opencode-v2-e2e-step-1',
    sessionId: V2_SESSION_ID,
    type: 'assistant',
    seq: 1,
    timeCreated: V2_STEP_ONE_TIME,
    data: v2AssistantStep({
      input: 1200,
      output: 30,
      reasoning: 90,
      cacheRead: 4000,
      cost: 0.0063,
    }),
  },
  {
    id: 'opencode-v2-e2e-step-2',
    sessionId: V2_SESSION_ID,
    type: 'assistant',
    seq: 2,
    timeCreated: V2_STEP_ONE_TIME + 20_000,
    data: v2AssistantStep({ input: 300, output: 150, reasoning: 0, cacheRead: 5200, cost: 0.0047 }),
  },
  {
    id: 'opencode-v2-e2e-step-failed',
    sessionId: V2_SESSION_ID,
    type: 'assistant',
    seq: 3,
    timeCreated: V2_STEP_ONE_TIME + 40_000,
    data: JSON.stringify({
      agent: 'build',
      model: { id: 'claude-sonnet-4-5', providerID: 'anthropic', variant: 'default' },
      content: [],
      time: { created: 0 },
    }),
  },
  {
    id: 'opencode-v2-e2e-idle-1',
    sessionId: V2_SESSION_ID,
    type: 'idle',
    seq: 4,
    timeCreated: V2_STEP_ONE_TIME + 60_000,
    data: JSON.stringify({ outcome: 'completed', time: { created: 0 } }),
  },
];

/**
 * A database with OpenCode V2's `session_v2` and `session_message` tables (the columns the
 * adapter reads plus the NOT NULL ones). Run `createOpenCodeFixtureDb` on the same path
 * afterwards for a database migrated in place, which keeps the V1 tables.
 */
export function createOpenCodeV2FixtureDb(
  dbPath: string,
  sessions: readonly OpenCodeV2SessionFixture[],
  messages: readonly OpenCodeV2MessageFixture[],
): void {
  const database = openFixtureDb(dbPath);

  try {
    database.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const insertSession = database.prepare(
      'INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMessage = database.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    for (const session of sessions) {
      insertSession.run(
        session.id,
        'global',
        session.id,
        session.directory,
        '2.0.32',
        session.timeCreated,
        session.timeCreated,
      );
    }

    for (const message of messages) {
      insertMessage.run(
        message.id,
        message.sessionId,
        message.type,
        message.seq,
        message.timeCreated,
        message.timeCreated,
        message.data,
      );
    }
  } finally {
    database.close();
  }
}
