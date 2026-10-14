import { describe, expect, it } from 'vitest';

import { kinds, pipe, readEvents } from '../../src/index.js';
import { CodexSourceAdapter } from '../../src/sources/codex/index.js';
import { fixturePath } from '../helpers/fixtures.js';

const SESSION = fixturePath(import.meta.url, 'fixtures/tool-usage.jsonl');

describe('example: tool usage per name', () => {
  it('counts the tool calls in a session by name and status', async () => {
    const codex = new CodexSourceAdapter();
    const calls = new Map<string, number>();
    const unanswered: string[] = [];

    for await (const call of pipe(readEvents(codex, SESSION), kinds('tool_call'))) {
      calls.set(call.name, (calls.get(call.name) ?? 0) + 1);

      if (call.status === 'unknown') {
        unanswered.push(call.toolCallId ?? call.name);
      }
    }

    expect(Object.fromEntries(calls)).toEqual({ exec_command: 3, apply_patch: 1, web_search: 1 });
    expect(unanswered).toEqual(['call-4']);
  });
});
