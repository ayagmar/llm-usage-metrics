import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenCodeSourceAdapter } from '../../../src/sources/opencode/index.js';
import { collect } from '../../../src/stream/collect.js';
import { loadDatabaseSync, requireDatabaseSync } from '../../helpers/sqlite.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

type StepTokens = { input: number; output: number; reasoning: number; read: number };

const SESSION_ID = 'ses_multi_step';
const START = Date.parse('2026-05-01T10:00:00.000Z');

// OpenCode V1 since April 2026 (#21047): output excludes reasoning, total includes it.
function tokensOf(step: StepTokens) {
  return {
    total: step.input + step.output + step.reasoning + step.read,
    input: step.input,
    output: step.output,
    reasoning: step.reasoning,
    cache: { read: step.read, write: 0 },
  };
}

function stepFinish(step: StepTokens, cost: number): string {
  return JSON.stringify({
    type: 'step-finish',
    reason: 'tool-calls',
    cost,
    tokens: tokensOf(step),
  });
}

function assistantMessage(lastStep: StepTokens, cost: number): string {
  return JSON.stringify({
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
    path: { cwd: '/work/app', root: '/work/app' },
    cost,
    tokens: tokensOf(lastStep),
  });
}

/** A V1 database with the upstream `message` and `part` tables. */
async function createV1Db(
  messages: { id: string; data: string; parts: string[] }[],
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-multi-step-'));
  tempDirs.push(root);
  const dbPath = path.join(root, 'opencode.db');
  const database = new (requireDatabaseSync())(dbPath);

  try {
    database.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    `);
    const insertMessage = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    const insertPart = database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');

    messages.forEach((message, messageIndex) => {
      const time = START + messageIndex * 60_000;
      insertMessage.run(message.id, SESSION_ID, time, time, message.data);
      message.parts.forEach((part, partIndex) => {
        const partTime = time + partIndex * 1_000;
        insertPart.run(
          `${message.id}-part-${partIndex}`,
          message.id,
          SESSION_ID,
          partTime,
          partTime,
          part,
        );
      });
    });
  } finally {
    database.close();
  }

  return dbPath;
}

describe.runIf(loadDatabaseSync())('OpenCode multi-step messages', () => {
  it('reads each step of a multi-step message as its own request', async () => {
    // Two 150k-token prompts: priced as one request, they would cross a 200k tier.
    const first = { input: 150_000, output: 200, reasoning: 50, read: 4_000 };
    const second = { input: 150_300, output: 120, reasoning: 30, read: 5_000 };
    const dbPath = await createV1Db([
      {
        id: 'msg_two_steps',
        // Upstream sets the message's tokens to the last step's and adds up the costs.
        data: assistantMessage(second, 0.03),
        parts: [
          JSON.stringify({ type: 'step-start' }),
          JSON.stringify({ type: 'text', text: 'the "step-finish" part carries tokens' }),
          stepFinish(first, 0.02),
          JSON.stringify({ type: 'step-start' }),
          stepFinish(second, 0.01),
          '{"type":"step-finish", truncated',
        ],
      },
    ]);

    const events = await collect(new OpenCodeSourceAdapter({ dbPath }).read(dbPath));

    expect(events).toEqual([
      expect.objectContaining({
        timestamp: new Date(START + 2_000).toISOString(),
        inputTokens: 150_000,
        outputTokens: 250,
        reasoningTokens: 50,
        cacheReadTokens: 4_000,
        totalTokens: 154_250,
        singleRequest: true,
        costUsd: 0.02,
      }),
      expect.objectContaining({
        timestamp: new Date(START + 4_000).toISOString(),
        inputTokens: 150_300,
        outputTokens: 150,
        reasoningTokens: 30,
        cacheReadTokens: 5_000,
        totalTokens: 155_450,
        singleRequest: true,
        costUsd: 0.01,
      }),
    ]);
  });

  it('normalizes each step with its own total', async () => {
    const step = { input: 1_000, output: 200, reasoning: 50, read: 0 };
    const withoutTotal = JSON.stringify({
      type: 'step-finish',
      cost: 0.001,
      tokens: { input: 1_000, output: 250, reasoning: 50, cache: { read: 0, write: 0 } },
    });
    const dbPath = await createV1Db([
      {
        id: 'msg_mixed_totals',
        data: assistantMessage(step, 0.002),
        parts: [withoutTotal, stepFinish(step, 0.001)],
      },
    ]);

    const events = await collect(new OpenCodeSourceAdapter({ dbPath }).read(dbPath));

    expect(events.map((event) => [event.outputTokens, event.totalTokens])).toEqual([
      [250, 1_250],
      [250, 1_250],
    ]);
  });

  it('keeps a single-step message as stored', async () => {
    const only = { input: 500, output: 40, reasoning: 10, read: 0 };
    const dbPath = await createV1Db([
      { id: 'msg_one_step', data: assistantMessage(only, 0.004), parts: [stepFinish(only, 0.004)] },
      { id: 'msg_no_parts', data: assistantMessage(only, 0.004), parts: [] },
    ]);

    const events = await collect(new OpenCodeSourceAdapter({ dbPath }).read(dbPath));

    expect(
      events.map((event) => [event.inputTokens, event.outputTokens, event.totalTokens]),
    ).toEqual([
      [500, 50, 550],
      [500, 50, 550],
    ]);
  });

  it('asks for opencode.db when given the pre-release opencode-next.db', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-next-'));
    tempDirs.push(root);
    const dbPath = path.join(root, 'opencode-next.db');
    const database = new (requireDatabaseSync())(dbPath);

    try {
      database.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY);
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
          seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      `);
    } finally {
      database.close();
    }

    await expect(collect(new OpenCodeSourceAdapter({ dbPath }).read(dbPath))).rejects.toThrow(
      'Read opencode.db instead',
    );
  });
});
