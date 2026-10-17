import { open } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { asRecord } from '../../utils/as-record.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';

export type DshSessionLogReadOptions = {
  shouldParseLine: (lineText: string) => boolean;
  /** Called once per malformed line or damaged frame, with the skip reason. */
  onSkippedRow: (reason: string) => void;
  /** Bytes per read of a `.zstd` log; a test seam, defaults to 1 MiB. */
  readChunkBytes?: number;
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

const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * DeepSeek Harness appends one independently compressed zstd frame per flush,
 * so a whole-file decode would silently stop at the first frame. Frame starts
 * are located by the zstd magic number, because a torn tail frame still decodes
 * "successfully" to a truncated prefix and would otherwise hide the damage.
 *
 * The file is cut into slices as it is read: each slice runs from its start to
 * the next magic found at least four bytes past that start, or to the end of
 * the file. Yields each slice that starts with the magic, and `null` for one
 * that does not: that is damage rather than a frame, reported the same way as a
 * frame that fails to decode. Only the first slice can be damaged; its bytes are
 * dropped as they are read, so only a frame slice is ever held whole.
 */
async function* readFrameSlices(
  filePath: string,
  chunkBytes: number,
): AsyncGenerator<Buffer | null, void, undefined> {
  const handle = await open(filePath, 'r');

  try {
    // buffer[sliceStart, held) holds the current slice's bytes after the first
    // `dropped` ones. Yielded frames are views into earlier bytes of a buffer,
    // which later reads never overwrite: reads append past `held`, into a fresh
    // buffer when this one is full.
    let buffer = Buffer.alloc(0);
    let held = 0;
    let sliceStart = 0;
    let dropped = 0;
    let startsWithMagic: boolean | undefined;

    for (;;) {
      const liveBytes = held - sliceStart;

      if (buffer.length - held < chunkBytes) {
        const grown = Buffer.allocUnsafe(Math.max(liveBytes * 2, liveBytes + chunkBytes));
        buffer.copy(grown, 0, sliceStart, held);
        buffer = grown;
        held = liveBytes;
        sliceStart = 0;
      }

      const { bytesRead } = await handle.read(buffer, held, chunkBytes, null);

      if (bytesRead === 0) {
        break;
      }

      // Magic starts before held - 3 were ruled out by the previous search.
      let searchFrom = Math.max(
        sliceStart + ZSTD_FRAME_MAGIC.length - dropped,
        held - (ZSTD_FRAME_MAGIC.length - 1),
      );
      held += bytesRead;

      for (;;) {
        if (startsWithMagic === undefined && held - sliceStart >= ZSTD_FRAME_MAGIC.length) {
          startsWithMagic = buffer
            .subarray(sliceStart, sliceStart + ZSTD_FRAME_MAGIC.length)
            .equals(ZSTD_FRAME_MAGIC);
        }

        const nextOffset = buffer.subarray(0, held).indexOf(ZSTD_FRAME_MAGIC, searchFrom);

        if (nextOffset === -1) {
          break;
        }

        yield startsWithMagic === true ? buffer.subarray(sliceStart, nextOffset) : null;
        sliceStart = nextOffset;
        dropped = 0;
        startsWithMagic = true;
        searchFrom = nextOffset + ZSTD_FRAME_MAGIC.length;
      }

      // Keep three bytes of a damaged slice: a magic may continue in the next read.
      const keptBytes = ZSTD_FRAME_MAGIC.length - 1;

      if (startsWithMagic === false && held - sliceStart > keptBytes) {
        dropped += held - keptBytes - sliceStart;
        sliceStart = held - keptBytes;
      }
    }

    if (held - sliceStart + dropped > 0) {
      yield startsWithMagic === true ? buffer.subarray(sliceStart, held) : null;
    }
  } finally {
    await handle.close();
  }
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
  decoded: Buffer,
  options: DshSessionLogReadOptions,
): Generator<Record<string, unknown>, void, undefined> {
  // Lines never continue across frames: each frame is walked on its own.
  for (let lineStart = 0; lineStart <= decoded.length;) {
    const newline = decoded.indexOf(0x0a, lineStart);
    const lineEnd = newline === -1 ? decoded.length : newline;
    const line = decoded.toString('utf8', lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;

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
      onMalformedLine: () => {
        options.onSkippedRow('json_parse_error');
      },
    });
    return;
  }

  let decodedFrames = 0;

  for await (const frameBytes of readFrameSlices(
    filePath,
    options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES,
  )) {
    if (!frameBytes) {
      options.onSkippedRow(UNDECODABLE_FRAME_REASON);
      continue;
    }

    let decoded: Buffer;

    try {
      decoded = await decodeFrame(frameBytes);
    } catch {
      options.onSkippedRow(UNDECODABLE_FRAME_REASON);
      continue;
    }

    decodedFrames += 1;
    yield* parseJsonlLines(decoded, options);
  }

  if (decodedFrames === 0) {
    throw new DshSessionLogUnreadableError();
  }
}
