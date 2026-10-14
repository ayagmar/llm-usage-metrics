import { loadDatabaseSync } from './sqlite-fixture-db.js';

export type GooseSessionFixture = {
  id: string;
  modelConfigJson: string;
  providerName: string;
  createdAt: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

/** The Goose rows of the multi-source e2e and the golden fixture catalogue. */
export const E2E_GOOSE_SESSIONS: readonly GooseSessionFixture[] = [
  {
    id: 'goose-e2e-session',
    modelConfigJson: JSON.stringify({ model_name: 'gpt-goose-e2e' }),
    providerName: 'openai',
    createdAt: '2026-06-15T12:15:00.000Z',
    totalTokens: 180,
    inputTokens: 100,
    outputTokens: 50,
  },
];

export function createGooseFixtureDb(
  dbPath: string,
  sessions: readonly GooseSessionFixture[],
): void {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('Goose e2e fixtures require node:sqlite DatabaseSync support.');
  }

  const database = new DatabaseSync(dbPath);

  try {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model_config_json TEXT,
        provider_name TEXT,
        created_at TEXT,
        total_tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        accumulated_total_tokens INTEGER,
        accumulated_input_tokens INTEGER,
        accumulated_output_tokens INTEGER
      );
    `);

    const insertSession = database.prepare(`
      INSERT INTO sessions (
        id,
        model_config_json,
        provider_name,
        created_at,
        total_tokens,
        input_tokens,
        output_tokens,
        accumulated_total_tokens,
        accumulated_input_tokens,
        accumulated_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.modelConfigJson,
        session.providerName,
        session.createdAt,
        session.totalTokens,
        session.inputTokens,
        session.outputTokens,
      );
    }
  } finally {
    database.close();
  }
}
