import { readFile, stat } from 'node:fs/promises';

/** Refusing files above this size keeps one degenerate transcript from
 *  buffering unbounded memory and OOM-killing the whole run. */
export const MAX_JSON_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export type BoundedJsonReadResult =
  { ok: true; value: unknown } | { ok: false; reason: 'file_too_large' | 'json_parse_error' };

export async function readBoundedJsonFile(filePath: string): Promise<BoundedJsonReadResult> {
  try {
    const fileStat = await stat(filePath);

    if (fileStat.size > MAX_JSON_TRANSCRIPT_BYTES) {
      return { ok: false, reason: 'file_too_large' };
    }

    return { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) as unknown };
  } catch {
    return { ok: false, reason: 'json_parse_error' };
  }
}
