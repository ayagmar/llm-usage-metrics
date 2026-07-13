import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The config schema is served under a different filename; report schemas
// keep their own.
const SITE_FILENAME_BY_SCHEMA: Record<string, string> = {
  'config.schema.json': 'config-schema.json',
};

describe('schema site parity', () => {
  it('serves a byte-identical copy of every schema from site/public', async () => {
    const schemaDir = path.resolve('schema');
    const sitePublicDir = path.resolve('site/public');
    const schemaFiles = (await readdir(schemaDir)).filter((name) => name.endsWith('.json'));

    expect(schemaFiles.length).toBeGreaterThan(0);

    for (const name of schemaFiles) {
      const siteName = SITE_FILENAME_BY_SCHEMA[name] ?? name;
      const schemaContent = await readFile(path.join(schemaDir, name), 'utf8');
      const siteContent = await readFile(path.join(sitePublicDir, siteName), 'utf8');

      expect(siteContent, `${siteName} must be a byte-identical copy of schema/${name}`).toBe(
        schemaContent,
      );
    }
  });
});
