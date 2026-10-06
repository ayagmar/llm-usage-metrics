import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getClaudeSubagentMetaPath,
  readClaudeMessageKeys,
  resolveClaudeForkParentPath,
} from '../../src/sources/claude/claude-fork-transcript.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createSubagentsDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-fork-transcript-'));
  tempDirs.push(root);
  const subagentsDir = path.join(root, 'session-1', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  return subagentsDir;
}

describe('claude fork transcripts', () => {
  it('only treats agent transcripts inside a subagents directory as subagents', () => {
    expect(getClaudeSubagentMetaPath('/p/session/subagents/agent-a1.jsonl')).toBe(
      path.join('/p/session/subagents', 'agent-a1.meta.json'),
    );
    expect(getClaudeSubagentMetaPath('/p/session/agent-a1.jsonl')).toBeUndefined();
    expect(getClaudeSubagentMetaPath('/p/session/subagents/notes.jsonl')).toBeUndefined();
  });

  it('ignores missing, malformed, non-fork, and unsafe meta sidecars', async () => {
    const subagentsDir = await createSubagentsDir();
    const transcript = (id: string) => path.join(subagentsDir, `agent-${id}.jsonl`);
    const writeMeta = (id: string, content: string) =>
      writeFile(path.join(subagentsDir, `agent-${id}.meta.json`), content, 'utf8');

    await writeMeta('malformed', '{not json');
    await writeMeta('fresh', JSON.stringify({ agentType: 'general-purpose' }));
    await writeMeta('unsafe', JSON.stringify({ isFork: true, parentAgentId: '../../etc' }));
    await writeMeta('nested', JSON.stringify({ isFork: true, parentAgentId: 'a1' }));

    expect(await resolveClaudeForkParentPath(transcript('missing'))).toBeUndefined();
    expect(await resolveClaudeForkParentPath(transcript('malformed'))).toBeUndefined();
    expect(await resolveClaudeForkParentPath(transcript('fresh'))).toBeUndefined();
    expect(await resolveClaudeForkParentPath(transcript('unsafe'))).toBeUndefined();
    expect(await resolveClaudeForkParentPath(transcript('nested'))).toBe(transcript('a1'));
  });

  it('reads message keys from assistant rows and tolerates a missing parent', async () => {
    const subagentsDir = await createSubagentsDir();
    const parentPath = path.join(subagentsDir, 'agent-parent.jsonl');
    await writeFile(
      parentPath,
      [
        JSON.stringify({ type: 'assistant', requestId: 'req_1', message: { id: 'msg_1' } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_2' } }),
        JSON.stringify({ type: 'assistant', message: {} }),
        '{"type":"assistant", broken',
      ].join('\n'),
      'utf8',
    );

    expect([...(await readClaudeMessageKeys(parentPath))]).toEqual(['msg_1\0req_1', 'msg_2\0']);
    expect(await readClaudeMessageKeys(path.join(subagentsDir, 'gone.jsonl'))).toEqual(new Set());
  });
});
