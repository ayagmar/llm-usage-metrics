import { realpathSync } from 'node:fs';
import os from 'node:os';

/**
 * Temp root with symlinks and Windows 8.3 short names resolved, matching the canonical
 * paths discovery returns (macOS /var -> /private/var, Windows RUNNER~1).
 */
export function canonicalTmpdir(): string {
  return realpathSync.native(os.tmpdir());
}
