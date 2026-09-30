import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import type { SourceSkippedRowReasonStat } from '../source-adapter.js';

export type DshSessionLogRead = {
  /** Non-empty JSONL lines in append order. */
  lines: string[];
  /** Per-file counters for appended frames that were damaged and skipped. */
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

export class DshSessionLogUnreadableError extends Error {
  public constructor(message = 'DSH session log could not be decompressed') {
    super(message);
    this.name = 'DshSessionLogUnreadableError';
  }
}

/** Zstandard frame magic number, little-endian encoding of `0xFD2FB528`. */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const UNDECODABLE_FRAME_REASON = 'undecodable_jsonl_frame';

/**
 * DeepSeek Harness appends one independently compressed zstd frame per flush,
 * so a whole-file decode would silently stop at the first frame. Frame starts
 * are located by the zstd magic number, because a torn tail frame still decodes
 * "successfully" to a truncated prefix and would otherwise hide the damage.
 *
 * A slice without the frame magic is damage rather than a frame, and is
 * reported the same way as a frame that fails to decode.
 */
function collectFrameSlices(compressed: Buffer): { frames: Buffer[]; damagedSlices: number } {
  const frames: Buffer[] = [];
  let damagedSlices = 0;
  let offset = 0;

  while (offset < compressed.length) {
    const nextOffset = compressed.indexOf(ZSTD_FRAME_MAGIC, offset + ZSTD_FRAME_MAGIC.length);
    const slice =
      nextOffset === -1 ? compressed.subarray(offset) : compressed.subarray(offset, nextOffset);

    if (slice.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
      frames.push(slice);
    } else {
      damagedSlices += 1;
    }

    if (nextOffset === -1) {
      break;
    }

    offset = nextOffset;
  }

  return { frames, damagedSlices };
}

async function decodeFrame(frameBytes: Buffer): Promise<Buffer> {
  const engine = createZstdDecompress();
  const chunks: Buffer[] = [];

  engine.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  await pipeline(Readable.from([frameBytes]), engine);

  const decoded = Buffer.concat(chunks);
  const frameConsumed = engine.bytesWritten === frameBytes.length;

  // A torn tail frame still decodes "successfully": zstd consumes the whole
  // truncated slice and reports the full byte count while yielding nothing or
  // only the beginning of the committed batch. Every committed DSH frame holds
  // at least one line, so an empty frame is damage, not data.
  if (decoded.length === 0 || !frameConsumed) {
    throw new DshSessionLogUnreadableError('DSH session log frame is incomplete');
  }

  return decoded;
}

function splitJsonlLines(text: string): string[] {
  const lines: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.length > 0) {
      lines.push(line);
    }
  }

  return lines;
}

/**
 * Read a DSH session log. `session.v3.jsonl.zstd` is the default on-disk
 * encoding, but the harness can be configured to write plain `session*.jsonl`;
 * both are read so switching the harness encoding never hides sessions.
 */
export async function readDshSessionLog(filePath: string): Promise<DshSessionLogRead> {
  const contents = await readFile(filePath);

  if (!filePath.toLowerCase().endsWith('.zstd')) {
    return {
      lines: splitJsonlLines(contents.toString('utf8')),
      skippedRowReasons: [],
    };
  }

  const lines: string[] = [];
  let decodedFrames = 0;
  const { frames, damagedSlices } = collectFrameSlices(contents);
  let undecodableFrames = damagedSlices;

  for (const frameBytes of frames) {
    try {
      const decoded = await decodeFrame(frameBytes);

      decodedFrames += 1;
      lines.push(...splitJsonlLines(decoded.toString('utf8')));
    } catch {
      undecodableFrames += 1;
    }
  }

  if (decodedFrames === 0) {
    throw new DshSessionLogUnreadableError();
  }

  return {
    lines,
    skippedRowReasons:
      undecodableFrames > 0 ? [{ reason: UNDECODABLE_FRAME_REASON, count: undecodableFrames }] : [],
  };
}
