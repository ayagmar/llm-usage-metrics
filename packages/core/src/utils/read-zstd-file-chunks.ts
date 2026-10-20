import type { ReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';

/** Zstandard frame magic number, little-endian encoding of `0xFD2FB528`. */
export const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Magic, descriptor, window descriptor, a 4-byte dictionary id and an 8-byte content size. */
const MAX_FRAME_HEADER_BYTES = 18;

/** Whether a path names a zstd-compressed file (`.zst`), read decompressed. */
export function isZstdFilePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zst');
}

/**
 * The decoded size a zstd frame header declares, or undefined when it declares none.
 * Throws when the bytes do not start with a zstd frame.
 */
function readFrameContentSize(header: Buffer, filePath: string): number | undefined {
  if (!header.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
    throw new Error(`Not a zstd file: ${filePath}`);
  }

  const descriptor = header[4];
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
  const sizeOffset = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 0x03];

  if (sizeBytes === 0 || header.length < sizeOffset + sizeBytes) {
    return undefined;
  }

  switch (sizeBytes) {
    case 1:
      return header[sizeOffset];
    case 2:
      return header.readUInt16LE(sizeOffset) + 256;
    case 4:
      return header.readUInt32LE(sizeOffset);
    default:
      return Number(header.readBigUInt64LE(sizeOffset));
  }
}

/**
 * Yields a zstd file's decompressed bytes as they decode, so memory stays bounded by a
 * chunk, and closes the file before a return or throw finishes. Node 22 and Bun end a
 * truncated stream without an error, so a decode shorter than the size the first frame
 * declares throws here, as Node 24 does. A file of several frames throws on Node, which
 * would decode only the first; Codex writes one.
 */
export async function* readZstdFileChunks(
  filePath: string,
): AsyncGenerator<Buffer, void, undefined> {
  const handle = await open(filePath, 'r');
  const decompress = createZstdDecompress();
  let compressed: ReadStream | undefined;

  try {
    const header = Buffer.alloc(MAX_FRAME_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const contentSize = readFrameContentSize(header.subarray(0, bytesRead), filePath);
    compressed = handle.createReadStream({ start: 0, autoClose: false });
    compressed.on('error', (error) => decompress.destroy(error));
    let decodedBytes = 0;

    for await (const chunk of compressed.pipe(decompress) as AsyncIterable<Buffer>) {
      decodedBytes += chunk.length;
      yield chunk;
    }

    if (contentSize !== undefined && decodedBytes < contentSize) {
      throw new Error(`Zstd file is truncated: ${filePath}`);
    }

    // Node decodes only the first frame and ignores what follows it.
    if (decompress.bytesWritten < compressed.bytesRead) {
      throw new Error(`Zstd file has data after its first frame: ${filePath}`);
    }
  } finally {
    compressed?.destroy();
    decompress.destroy();
    await handle.close();
  }
}
