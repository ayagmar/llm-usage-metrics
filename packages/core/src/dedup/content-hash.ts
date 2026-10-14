import { createHash } from 'node:crypto';

import type { CostMode, UsageEvent } from '../domain/usage-event.js';

export function computeEventContentHash(event: UsageEvent & { costMode: CostMode }): string {
  const fields = [
    event.source.toLowerCase(),
    event.sessionId,
    event.timestamp,
    event.model ?? '',
    event.provider ?? '',
    event.repoRoot ?? '',
    event.inputTokens,
    event.outputTokens,
    event.reasoningTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    // cacheWrite1hTokens is left out: it only splits cacheWriteTokens, and leaving it out
    // keeps events stored before it existed matching their reparsed copies.
    event.totalTokens,
    event.costMode,
    event.costUsd ?? '',
  ];

  return createHash('sha256').update(fields.map(String).join('\x1f')).digest('hex').slice(0, 16);
}
