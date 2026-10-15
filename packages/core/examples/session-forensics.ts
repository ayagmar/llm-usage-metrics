// Per-session token, cache and cost forensics over claude, codex and pi, plus repeated user
// prompts within and across sessions. Prompts are compared by sha256 fingerprint: the
// output holds counts and hashes, not text, paths or session ids. The fingerprints are
// unsalted, so a short or common prompt can be recovered by hashing guesses; treat the
// output as you would the prompts.
//
//   pnpm exec tsx examples/session-forensics.ts
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { bySession, createSourceContext, kinds, pipe } from '@ayagmar/agent-sessions';
import type { SourceContext } from '@ayagmar/agent-sessions';
import { readSources } from '@ayagmar/agent-sessions/registry';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
// The same prompt retyped with other spacing or case counts as a repeat.
const fingerprint = (text: string) => sha(text.replaceAll(/\s+/gu, ' ').trim().toLowerCase());
// `inputTokens` is fresh input: it excludes cache reads and writes.
const FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;

export async function sessionForensics(context: SourceContext) {
  const sessions = [];
  const sessionsByPrompt = new Map<string, number>();
  const read = readSources(context, ['claude', 'codex', 'pi'], { text: true });

  for await (const group of pipe(read, kinds('usage', 'message'), bySession())) {
    const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    let costUsd: number | undefined;
    const prompts = new Map<string, number>();

    for (const event of group.events) {
      if (event.kind === 'usage') {
        for (const field of FIELDS) tokens[field] += event[field];
        if (event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
      } else if (event.role === 'user' && event.text) {
        const hash = fingerprint(event.text);
        if (!prompts.has(hash)) sessionsByPrompt.set(hash, (sessionsByPrompt.get(hash) ?? 0) + 1);
        prompts.set(hash, (prompts.get(hash) ?? 0) + 1);
      }
    }

    const system = group.events.filter((e) => e.kind === 'message' && e.role === 'system');
    // Cache hit ratio = cache read / (fresh input + cache read). Cache writes are left out
    // of the denominator, as in the session-cost-forensics skill.
    const prompted = tokens.inputTokens + tokens.cacheReadTokens;
    sessions.push({
      source: group.source,
      session: sha(group.sessionId),
      tokens,
      costUsd,
      cacheHitRatio: prompted > 0 ? tokens.cacheReadTokens / prompted : undefined,
      systemMessages: system.length,
      repeatedPrompts: [...prompts.values()].reduce((sum, count) => sum + count - 1, 0),
    });
  }

  const shared = [...sessionsByPrompt].filter(([, count]) => count > 1);
  return { sessions, crossSessionPrompts: shared.map(([prompt, n]) => ({ prompt, sessions: n })) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await sessionForensics(createSourceContext()), null, 2));
}
