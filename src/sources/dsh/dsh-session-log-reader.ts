import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { asRecord } from '../../utils/as-record.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';

export type DshSessionLogReadOptions = {
  shouldParseLine: (lineText: string) => boolean;
  /** Called once per malformed line or damaged frame, with the skip reason. */
  onSkippedRow: (reason: string) => void;
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

/** One flush is a handful of lines; a frame inflating past this is damage or a zstd bomb. */
const MAX_DECODED_FRAME_BYTES = 64 * 1024 * 1024;

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
  let decodedBytes = 0;

  // Consume the readable side too, so decompression errors cannot arrive after
  // the pipeline has resolved on the engine's writable finish event.
  await pipeline(
    Readable.from([frameBytes]),
    engine,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        decodedBytes += chunk.length;

        if (decodedBytes > MAX_DECODED_FRAME_BYTES) {
          callback(new DshSessionLogUnreadableError('DSH session log frame is too large'));
          return;
        }

        chunks.push(chunk);
        callback();
      },
    }),
  );

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

function* parseJsonlLines(
  text: string,
  options: DshSessionLogReadOptions,
): Generator<Record<string, unknown>, void, undefined> {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.length === 0 || !options.shouldParseLine(line)) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      options.onSkippedRow('json_parse_error');
      continue;
    }

    const record = asRecord(parsed);

    if (record) {
      yield record;
    }
  }
}

/**
 * Read a DSH session log as JSONL records in append order, without holding the
 * decoded log in memory. `session.v3.jsonl.zstd` is the default on-disk
 * encoding, but the harness can be configured to write plain `session*.jsonl`;
 * both are read so switching the harness encoding never hides sessions.
 *
 * Throws DshSessionLogUnreadableError when no zstd frame decodes.
 */
export async function* readDshSessionLogRecords(
  filePath: string,
  options: DshSessionLogReadOptions,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  if (!filePath.toLowerCase().endsWith('.zstd')) {
    yield* readJsonlObjects(filePath, {
      shouldParseLine: options.shouldParseLine,
      onMalformedLine: () => options.onSkippedRow('json_parse_error'),
    });
    return;
  }

  const { frames, damagedSlices } = collectFrameSlices(await readFile(filePath));
  let decodedFrames = 0;

  for (let index = 0; index < damagedSlices; index += 1) {
    options.onSkippedRow(UNDECODABLE_FRAME_REASON);
  }

  for (const frameBytes of frames) {
    let decoded: Buffer;

    try {
      decoded = await decodeFrame(frameBytes);
    } catch {
      options.onSkippedRow(UNDECODABLE_FRAME_REASON);
      continue;
    }

    decodedFrames += 1;
    yield* parseJsonlLines(decoded.toString('utf8'), options);
  }

  if (decodedFrames === 0) {
    throw new DshSessionLogUnreadableError();
  }
}
