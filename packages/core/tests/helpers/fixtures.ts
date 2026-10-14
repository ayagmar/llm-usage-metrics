import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A package fixture, resolved from the calling test file:
 * `fixturePath(import.meta.url, '../../fixtures/pi/session.jsonl')`.
 */
export function fixturePath(importMetaUrl: string, ...segments: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), ...segments);
}

const repoFixturesDir = fileURLToPath(new URL('../../../../tests/fixtures/', import.meta.url));

/**
 * A fixture under the repository's root `tests/fixtures`, for fixtures that root tests
 * still read. Removed once every adapter fixture lives in the package (M3-T5).
 */
export function repoFixturePath(...segments: string[]): string {
  return path.join(repoFixturesDir, ...segments);
}
