import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionForensics } from '../../examples/session-forensics.js';
import { createSourceContext } from '../../src/index.js';
import { fixturePath } from '../helpers/fixtures.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

// Each fixture at its agent's default location under the home directory.
const LAYOUT: Record<string, string> = {
  'claude-repeat.jsonl': '.claude/projects/-work-fx/fx-claude-repeat.jsonl',
  'claude-lint.jsonl': '.claude/projects/-work-fx/fx-claude-lint.jsonl',
  'codex.jsonl': '.codex/sessions/2026/08/03/rollout-2026-08-03T08-00-00-fx-codex.jsonl',
  'pi.jsonl': '.pi/agent/sessions/--work-fx--/2026-08-04T07-00-00-000Z_fx-pi.jsonl',
};

describe('example: session forensics', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(canonicalTmpdir(), 'session-forensics-'));

    for (const [fixture, target] of Object.entries(LAYOUT)) {
      const destination = path.join(homeDir, target);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(fixturePath(import.meta.url, 'fixtures/forensics', fixture), destination);
    }
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports tokens, cache hits, system messages and repeated prompts per session', async () => {
    // `env: {}` keeps a CODEX_HOME or CLAUDE_CONFIG_DIR on the host from moving the roots.
    const report = await sessionForensics(createSourceContext({ homeDir, env: {} }));

    expect(report.sessions).toEqual([
      {
        source: 'pi',
        session: sha('fx-pi'),
        tokens: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 40 },
        costUsd: 0.002,
        // cache read / (fresh input + cache read): the 5 cache-write tokens are left out.
        cacheHitRatio: 20 / 120,
        systemMessages: 0,
        repeatedPrompts: 0,
      },
      {
        source: 'codex',
        session: sha('fx-codex'),
        // Codex logs input including cache reads; the event's input excludes them.
        tokens: { inputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 40 },
        costUsd: undefined,
        cacheHitRatio: 0.6,
        // The developer message.
        systemMessages: 1,
        repeatedPrompts: 0,
      },
      {
        source: 'claude',
        session: sha('fx-claude-lint'),
        tokens: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 100, outputTokens: 50 },
        costUsd: undefined,
        cacheHitRatio: 0,
        systemMessages: 0,
        repeatedPrompts: 0,
      },
      {
        source: 'claude',
        session: sha('fx-claude-repeat'),
        tokens: { inputTokens: 110, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 50 },
        costUsd: undefined,
        cacheHitRatio: 900 / 1010,
        // The compaction summary.
        systemMessages: 1,
        // "Run the tests" retyped as "run the   TESTS ".
        repeatedPrompts: 1,
      },
    ]);
    expect(report.crossSessionPrompts).toEqual([
      { prompt: sha('run the tests'), sessions: 2 },
      { prompt: sha('fix the lint errors'), sessions: 2 },
    ]);
  });

  it('prints no prompt text, path or session id', async () => {
    const output = JSON.stringify(
      await sessionForensics(createSourceContext({ homeDir, env: {} })),
    );

    for (const leaked of ['Run the tests', 'lint', 'Summary', '/work/fx', 'fx-', homeDir]) {
      expect(output).not.toContain(leaked);
    }
  });

  it('finds nothing in an empty home', async () => {
    const emptyHome = mkdtempSync(path.join(canonicalTmpdir(), 'session-forensics-empty-'));

    try {
      expect(await sessionForensics(createSourceContext({ homeDir: emptyHome, env: {} }))).toEqual({
        sessions: [],
        crossSessionPrompts: [],
      });
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
