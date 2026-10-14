import { open } from 'node:fs/promises';

export const DEFAULT_CHUNK_SIZE_BYTES = 1024 * 1024;

/**
 * Yields a file's chunks and closes the file before a return or throw finishes, so a
 * consumer that stops early leaves no fd open.
 */
export async function* readFileChunks(
  filePath: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE_BYTES,
): AsyncGenerator<Buffer, void, undefined> {
  const handle = await open(filePath, 'r');

  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize);

      if (bytesRead === 0) {
        return;
      }

      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
