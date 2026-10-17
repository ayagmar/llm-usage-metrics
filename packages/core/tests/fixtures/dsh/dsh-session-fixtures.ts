import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

export type DshSessionHeaderFixture = {
  id: string;
  createdAt: number;
  cwd?: string;
  version?: number;
  isSeeded?: boolean;
  delegationDepth?: number;
  agentPreset?: string;
};

export type DshUsageFixture = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

export type DshMessageSourceFixture = {
  provider?: string;
  model?: string;
};

export type DshLineFixture =
  | { type: 'session'; header: DshSessionHeaderFixture }
  | {
      type: 'assistant/message';
      seq: number;
      time: number;
      usage: DshUsageFixture;
      source?: DshMessageSourceFixture;
    }
  | {
      type: 'session/title-llm-request';
      seq: number;
      time: number;
      route?: DshMessageSourceFixture;
    }
  | { type: 'step/end'; seq: number; time: number; turn?: number; step?: number }
  | { type: 'tool/call'; seq: number; time: number }
  | { type: 'raw'; text: string };

export type DshSessionFixture = {
  header: DshSessionHeaderFixture;
  lines: DshLineFixture[];
};

export function dshSessionHeader(header: DshSessionHeaderFixture): Record<string, unknown> {
  return {
    type: 'session',
    version: header.version ?? 3,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd ?? '/tmp/dsh-fixture-project',
    isSeeded: header.isSeeded ?? false,
    delegationDepth: header.delegationDepth ?? 0,
    agentPreset: header.agentPreset ?? 'standard',
  };
}

export function dshAssistantMessageFixture(params: {
  seq: number;
  time: number | string;
  usage: DshUsageFixture;
  source?: DshMessageSourceFixture;
  turn?: number;
  step?: number;
  text?: string;
}): Record<string, unknown> {
  const source = {
    kind: 'model',
    provider: params.source?.provider ?? 'deepseek-official',
    model: params.source?.model ?? 'deepseek-flash',
  };

  return {
    type: 'assistant/message',
    seq: params.seq,
    time: params.time,
    data: {
      turn: params.turn ?? 1,
      step: params.step ?? 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: params.text ?? 'fixture response' }],
        source,
        id: `message-${params.seq}`,
      },
      usage: {
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        totalTokens: params.usage.totalTokens ?? 0,
        cacheReadTokens: params.usage.cacheReadTokens ?? 0,
        ...(params.usage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: params.usage.cacheWriteTokens }),
        reasoningTokens: params.usage.reasoningTokens ?? 0,
      },
      surfaceOp: 'append',
    },
  };
}

export function dshTitleRequestFixture(params: {
  seq: number;
  time: number;
  route?: DshMessageSourceFixture;
}): Record<string, unknown> {
  return {
    type: 'session/title-llm-request',
    seq: params.seq,
    time: params.time,
    data: {
      titleProvider: 'session-title-first-prompt-llm',
      route: {
        provider: params.route?.provider ?? 'deepseek-official',
        model: params.route?.model ?? 'deepseek-flash',
      },
      system: 'Create a concise title for an AI coding-assistant session.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture prompt' }] }],
      maxTokens: 64,
    },
  };
}

export function toDshSessionLine(fixture: DshLineFixture): string {
  switch (fixture.type) {
    case 'session':
      return JSON.stringify(dshSessionHeader(fixture.header));
    case 'assistant/message':
      return JSON.stringify(
        dshAssistantMessageFixture({ ...fixture, usage: fixture.usage, source: fixture.source }),
      );
    case 'session/title-llm-request':
      return JSON.stringify(dshTitleRequestFixture(fixture));
    case 'step/end':
      return JSON.stringify({
        type: 'step/end',
        seq: fixture.seq,
        time: fixture.time,
        data: { turn: fixture.turn ?? 1, step: fixture.step ?? 1 },
      });
    case 'tool/call':
      return JSON.stringify({
        type: 'tool/call',
        seq: fixture.seq,
        time: fixture.time,
        data: { turn: 1, step: 1, callId: `call-${fixture.seq}`, name: 'bash' },
      });
    case 'raw':
      return fixture.text;
  }
}

export function toDshSessionLines(fixture: DshSessionFixture): string[] {
  return [
    toDshSessionLine({ type: 'session', header: fixture.header }),
    ...fixture.lines.map(toDshSessionLine),
  ];
}

export type DshLogSegment = { frame: string[] } | { bytes: Buffer };

/**
 * Write a DSH session log the way the harness appends it: one independently
 * compressed zstd frame per flushed batch of lines. Pass `frames` to control
 * how lines are grouped into frames (defaults to one frame per line), or
 * `segments` to interleave raw bytes such as a damaged region.
 */
export async function writeDshSessionLog(params: {
  filePath: string;
  lines?: string[];
  frames?: string[][] | 'plain';
  segments?: DshLogSegment[];
  trailingBytes?: Buffer;
}): Promise<void> {
  await mkdir(path.dirname(params.filePath), { recursive: true });

  if (params.frames === 'plain') {
    const plainPath = params.filePath.replace(/\.zstd$/u, '');
    await writeFile(plainPath, `${(params.lines ?? []).join('\n')}\n`, 'utf8');
    return;
  }

  const frames = params.frames ?? (params.lines ?? []).map((line) => [line]);
  const chunks = frames.map((frameLines) => compressFrame(frameLines));

  if (params.segments) {
    for (const segment of params.segments) {
      chunks.push('bytes' in segment ? segment.bytes : compressFrame(segment.frame));
    }
  }

  if (params.trailingBytes) {
    chunks.push(params.trailingBytes);
  }

  await writeFile(params.filePath, Buffer.concat(chunks));
}

function compressFrame(lines: string[]): Buffer {
  return zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/**
 * Bytes of a frame that was interrupted mid-append: the batch is compressed
 * after being cut off, so the surviving text is a partial line.
 */
export function createTornTailBytes(partialLine: string): Buffer {
  const completeFrame = zstdCompressSync(Buffer.from(`${partialLine}\n`, 'utf8'));
  return completeFrame.subarray(0, Math.max(1, Math.floor(completeFrame.length / 2)));
}

export function resolveDshSessionLogPath(sessionDir: string): string {
  return path.join(sessionDir, 'session.v3.jsonl.zstd');
}
