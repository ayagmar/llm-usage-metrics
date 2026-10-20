import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../../src/cli/build-usage-data.js';
import { useIsolatedEnvironment } from '../../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../../helpers/offline-pricing.js';

const env = useIsolatedEnvironment();
useBundledPricingOnly();

// One assistant row: the same timestamp and usage in every session, with its own ids.
function assistantRow(sessionId: string, ids: { uuid: string; requestId: string; id: string }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-23T10:00:00.000Z',
    sessionId,
    cwd: '/tmp/repo',
    uuid: ids.uuid,
    requestId: ids.requestId,
    message: {
      id: ids.id,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    },
  });
}

async function writeSessions(
  name: string,
  rows: Record<string, { uuid: string; requestId: string; id: string }>,
): Promise<string> {
  const claudeDir = path.join(env.rootDir, name);
  const projectDir = path.join(claudeDir, 'project');
  await mkdir(projectDir, { recursive: true });

  for (const [sessionId, ids] of Object.entries(rows)) {
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${assistantRow(sessionId, ids)}\n`,
    );
  }

  return claudeDir;
}

async function countSessionsOfEvents(claudeDir: string): Promise<string[]> {
  const usageData = await buildUsageData('daily', {
    claudeDir,
    source: 'claude',
    all: true,
    json: true,
    pricingOffline: true,
    timezone: 'UTC',
  });
  return usageData.events.map((event) => event.sessionId);
}

describe('claude requests that share a timestamp and usage across sessions', () => {
  it('counts requests with different ids in each session, with the store off or on', async () => {
    const claudeDir = await writeSessions('distinct', {
      'session-1': { uuid: 'uuid-1', requestId: 'req_1', id: 'msg_1' },
      'session-2': { uuid: 'uuid-2', requestId: 'req_2', id: 'msg_2' },
    });

    expect(await countSessionsOfEvents(claudeDir)).toEqual(['session-1', 'session-2']);

    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(env.rootDir, 'distinct-events.db'));

    try {
      // A fresh parse into the store, then the stored events.
      expect(await countSessionsOfEvents(claudeDir)).toEqual(['session-1', 'session-2']);
      expect(await countSessionsOfEvents(claudeDir)).toEqual(['session-1', 'session-2']);
    } finally {
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', undefined);
    }
  });

  it('counts a request copied into another session with its ids once', async () => {
    const copied = { uuid: 'uuid-1', requestId: 'req_1', id: 'msg_1' };
    const claudeDir = await writeSessions('copied', { 'session-1': copied, 'session-2': copied });

    expect(await countSessionsOfEvents(claudeDir)).toEqual(['session-1']);
  });
});
