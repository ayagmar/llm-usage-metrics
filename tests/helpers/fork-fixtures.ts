import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function writeFileWithDirs(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function claudeRow(messageId: string, timestamp = '2026-06-23T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId: 'claude-session-1',
    uuid: `uuid-${messageId}`,
    requestId: `req-${messageId}`,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  });
}

/** A main session and two forks that replay its row; one fork ends in a malformed row. */
export async function writeClaudeForkSession(projectDir: string): Promise<string> {
  const sessionPath = path.join(projectDir, 'session-1.jsonl');
  const subagentsDir = path.join(projectDir, 'session-1', 'subagents');

  await writeFileWithDirs(sessionPath, claudeRow('msg_parent'));
  await writeFileWithDirs(
    path.join(subagentsDir, 'agent-a1.jsonl'),
    [claudeRow('msg_parent'), claudeRow('msg_a1'), '{"type":"assistant","usage":'].join('\n'),
  );
  await writeFileWithDirs(
    path.join(subagentsDir, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'fork', isFork: true }),
  );
  // A second fork of the same parent: the worker reuses its cached parent keys.
  await writeFileWithDirs(
    path.join(subagentsDir, 'agent-a2.jsonl'),
    [claudeRow('msg_parent'), claudeRow('msg_a2')].join('\n'),
  );
  await writeFileWithDirs(
    path.join(subagentsDir, 'agent-a2.meta.json'),
    JSON.stringify({ agentType: 'fork', isFork: true }),
  );

  return subagentsDir;
}

function piUsageRow(id: string, timestamp: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp,
    message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } },
  });
}

export /** A pi parent session and a fork that copies its row, plus a malformed usage row. */
async function writePiParentAndFork(parentDir: string, forkDir: string): Promise<void> {
  const parentPath = path.join(parentDir, '2026-02-12T20-00-00-000Z_parent-id.jsonl');

  await writeFileWithDirs(
    parentPath,
    [
      JSON.stringify({ type: 'session', id: 'parent-id', timestamp: '2026-02-12T20:00:00.000Z' }),
      piUsageRow('a1', '2026-02-12T20:01:00.000Z'),
    ].join('\n'),
  );
  await writeFileWithDirs(
    path.join(forkDir, '2026-02-12T20-05-00-000Z_fork-id.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        id: 'fork-id',
        timestamp: '2026-02-12T20:05:00.000Z',
        parentSession: parentPath,
      }),
      piUsageRow('a1', '2026-02-12T20:01:00.000Z'),
      piUsageRow('b1', '2026-02-12T20:06:00.000Z'),
      '{"type":"message","message":{"role":"assistant","usage":',
    ].join('\n'),
  );
}
