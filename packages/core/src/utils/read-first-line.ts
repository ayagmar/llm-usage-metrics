import { open } from 'node:fs/promises';

const DEFAULT_MAX_FIRST_LINE_BYTES = 64 * 1024;

/**
 * Reads only the first line of a file, up to `maxBytes`. Returns undefined when the file
 * cannot be read or the first line is longer than the limit.
 */
export async function readFirstLine(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_FIRST_LINE_BYTES,
): Promise<string | undefined> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
    const content = buffer.subarray(0, bytesRead);
    const newlineIndex = content.indexOf(0x0a);

    if (newlineIndex === -1 && bytesRead === maxBytes) {
      return undefined;
    }

    return content.subarray(0, newlineIndex === -1 ? bytesRead : newlineIndex).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await fileHandle?.close();
  }
}
