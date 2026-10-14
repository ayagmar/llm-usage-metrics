import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A package fixture, resolved from the calling test file:
 * `fixturePath(import.meta.url, '../../fixtures/pi/session.jsonl')`.
 */
export function fixturePath(importMetaUrl: string, ...segments: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), ...segments);
}
