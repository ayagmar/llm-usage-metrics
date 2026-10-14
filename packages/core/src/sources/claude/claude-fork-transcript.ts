import path from 'node:path';

import { asRecord } from '../../utils/as-record.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { asTrimmedText } from '../parsing-utils.js';
import { readBoundedJsonFile } from '../read-json-file.js';

const SUBAGENT_TRANSCRIPT_PATTERN = /^agent-([\w-]+)\.jsonl$/u;
const SUBAGENTS_DIR_NAME = 'subagents';
const CLAUDE_ASSISTANT_BYTES = Buffer.from('"assistant"');

/**
 * Subagent transcripts live at `<session>/subagents/agent-<id>.jsonl` next to an
 * `agent-<id>.meta.json` sidecar. Returns the sidecar path for subagent transcripts.
 */
export function getClaudeSubagentMetaPath(filePath: string): string | undefined {
  const match = SUBAGENT_TRANSCRIPT_PATTERN.exec(path.basename(filePath));

  if (!match || path.basename(path.dirname(filePath)) !== SUBAGENTS_DIR_NAME) {
    return undefined;
  }

  return path.join(path.dirname(filePath), `agent-${match[1]}.meta.json`);
}

/**
 * A forked subagent starts from a copy of its parent's conversation, so the parent's
 * API calls (same message and request ids) are replayed at the top of its transcript.
 * The parent is another subagent (`parentAgentId`) or, without one, the main session
 * transcript `<session>.jsonl`.
 */
export async function resolveClaudeForkParentPath(filePath: string): Promise<string | undefined> {
  const metaPath = getClaudeSubagentMetaPath(filePath);

  if (!metaPath) {
    return undefined;
  }

  const metaResult = await readBoundedJsonFile(metaPath);
  const meta = metaResult.ok ? asRecord(metaResult.value) : undefined;

  if (meta?.isFork !== true) {
    return undefined;
  }

  const subagentsDir = path.dirname(filePath);
  const parentAgentId = asTrimmedText(meta.parentAgentId);

  if (parentAgentId) {
    return SUBAGENT_TRANSCRIPT_PATTERN.test(`agent-${parentAgentId}.jsonl`)
      ? path.join(subagentsDir, `agent-${parentAgentId}.jsonl`)
      : undefined;
  }

  return `${path.dirname(subagentsDir)}.jsonl`;
}

export function getClaudeMessageKey(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  const messageId = asTrimmedText(message.id);

  if (!messageId) {
    return undefined;
  }

  // Retries reuse the message id under a fresh requestId, so key on both.
  const requestId = asTrimmedText(line.requestId) ?? asTrimmedText(line.request_id) ?? '';
  return `${messageId}\0${requestId}`;
}

/** Message keys of every assistant row in a transcript; empty when it cannot be read. */
export async function readClaudeMessageKeys(filePath: string): Promise<Set<string>> {
  const messageKeys = new Set<string>();

  try {
    for await (const line of readJsonlObjects(filePath, {
      shouldParseLineBytes: (lineBytes) => lineBytes.includes(CLAUDE_ASSISTANT_BYTES),
    })) {
      const message = asRecord(line.message);
      const messageKey = message ? getClaudeMessageKey(line, message) : undefined;

      if (messageKey) {
        messageKeys.add(messageKey);
      }
    }
  } catch {
    // A missing or unreadable parent leaves the fork's rows counted.
  }

  return messageKeys;
}
